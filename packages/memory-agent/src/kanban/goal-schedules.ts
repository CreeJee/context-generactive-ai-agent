import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { VerdictFailure } from "./failures.ts";

/**
 * What the project scheduler stores about kanban Goals (docs/kanban-orchestration.md "프로젝트
 * 스케줄러"): each Goal's priority and target branch, the Goals it waits for, where its merge into
 * the target stands, and the branches a project never merges into on its own.
 */

export const GoalPriority = Schema.Literals(["high", "normal", "low"]);
export type GoalPriority = typeof GoalPriority.Type;

/** How many slots a Goal of each priority takes per turn of the round-robin. */
export const priorityWeight = {
  high: 4,
  normal: 2,
  low: 1,
} as const satisfies { readonly [Priority in GoalPriority]: number };

/** Branches a project protects when the user has not chosen any. */
export const defaultProtectedBranches = ["main", "staging"] as const;

export const ProtectedBranches = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)),
);

/** Where a Goal's merge into its target branch stands. Only metadata, never provider text. */
export const GoalMergeState = Schema.Union([
  /** The Goal branch at `head` is being checked as a whole. */
  Schema.TaggedStruct("Verifying", { head: Schema.String }),
  /** The Goal-level check failed at `head`; a new Goal branch commit is checked again. */
  Schema.TaggedStruct("VerifyFailed", { head: Schema.String, verdict: VerdictFailure }),
  /** The target is checked out with uncommitted changes there; the merge waits for them. */
  Schema.TaggedStruct("WaitingWorktree", { head: Schema.String, worktree: Schema.String }),
  /** The target kept moving while the merge ran; the next look tries again. */
  Schema.TaggedStruct("TargetMoving", {}),
  /** A person decides (protected branch or conflict); the request names the wait. */
  Schema.TaggedStruct("AwaitingDecision", { requestId: Schema.String }),
  Schema.TaggedStruct("Merged", { commit: Schema.String }),
  /** The person merges by hand; the Goal branch stays. */
  Schema.TaggedStruct("ManualMerge", {}),
  /** The push and pull request ran without a recorded result. Never run again on its own. */
  Schema.TaggedStruct("PullRequestPending", {}),
  Schema.TaggedStruct("PullRequestCreated", { url: Schema.String }),
  /** The owner stopped while a pull request was being made; a person checks what happened. */
  Schema.TaggedStruct("PullRequestUncertain", {}),
  Schema.TaggedStruct("PullRequestFailed", { stage: Schema.Literals(["push", "create"]) }),
  Schema.TaggedStruct("Stopped", {
    reason: Schema.Literals(["no_target", "target_missing", "conflict_stopped", "goal_replaced"]),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type GoalMergeState = typeof GoalMergeState.Type;

const settledMerge = GoalMergeState.match({
  Merged: () => true,
  ManualMerge: () => true,
  PullRequestPending: () => true,
  PullRequestCreated: () => true,
  PullRequestUncertain: () => true,
  PullRequestFailed: () => true,
  Stopped: () => true,
  Verifying: () => false,
  VerifyFailed: () => false,
  WaitingWorktree: () => false,
  TargetMoving: () => false,
  AwaitingDecision: () => false,
});

/** A merge that is over: nothing more happens to it without a person. */
export const mergeSettled = (state: GoalMergeState | null) => state !== null && settledMerge(state);

const releasingMerge = GoalMergeState.match({
  Merged: () => true,
  ManualMerge: () => true,
  PullRequestPending: () => false,
  PullRequestCreated: () => false,
  PullRequestUncertain: () => false,
  PullRequestFailed: () => false,
  Stopped: () => false,
  Verifying: () => false,
  VerifyFailed: () => false,
  WaitingWorktree: () => false,
  TargetMoving: () => false,
  AwaitingDecision: () => false,
});

/** A Goal that waits for this one may go on: its work is in the target, or a person took it. */
export const mergeReleases = (state: GoalMergeState | null) =>
  state !== null && releasingMerge(state);

export interface GoalSchedule {
  readonly goalInstanceId: string;
  readonly projectId: string;
  readonly priority: GoalPriority;
  readonly targetBranch: string | null;
  readonly upstreamPending: boolean;
  readonly merge: GoalMergeState | null;
  readonly verifiedHead: string | null;
}

export class GoalScheduleRefused extends Schema.TaggedError<GoalScheduleRefused>()(
  "GoalScheduleRefused",
  {
    reason: Schema.Literals([
      "goal_missing",
      "self_dependency",
      "other_project",
      "dependency_cycle",
      "invalid_branch",
    ]),
  },
) {}

export class GoalScheduleStorageFailed extends Schema.TaggedError<GoalScheduleStorageFailed>()(
  "GoalScheduleStorageFailed",
  {
    reason: Schema.Union([
      /** The database or a stored row failed; `cause` has the SQL or decode error. */
      Schema.TaggedStruct("Storage", {}),
      /** A value the owner made did not encode for storage. */
      Schema.TaggedStruct("Encode", {}),
    ]),
    cause: Schema.Defect(),
  },
) {}

const ScheduleRow = Schema.Struct({
  goal_instance_id: Schema.String,
  project_id: Schema.String,
  priority: GoalPriority,
  target_branch: Schema.NullOr(Schema.String),
  upstream_pending: Schema.Literals([0, 1]),
  merge_json: Schema.NullOr(Schema.fromJsonString(GoalMergeState)),
  verified_head: Schema.NullOr(Schema.String),
});
const DependencyRow = Schema.Struct({ goal_instance_id: Schema.String, depends_on: Schema.String });
const SettingsRow = Schema.Struct({
  protected_branches_json: Schema.fromJsonString(ProtectedBranches),
});
const encodeMerge = Schema.encodeEffect(Schema.fromJsonString(GoalMergeState));
const encodeBranches = Schema.encodeEffect(Schema.fromJsonString(ProtectedBranches));

const toSchedule = (row: typeof ScheduleRow.Type): GoalSchedule => ({
  goalInstanceId: row.goal_instance_id,
  projectId: row.project_id,
  priority: row.priority,
  targetBranch: row.target_branch,
  upstreamPending: row.upstream_pending === 1,
  merge: row.merge_json,
  verifiedHead: row.verified_head,
});

/** Whether `from` reaches `to` along the dependency edges. */
const reaches = (edges: ReadonlyMap<string, readonly string[]>, from: string, to: string) => {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const next = stack.pop() ?? "";
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return false;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Clock.currentTimeMillis;
  const failed = (cause: SqlError.SqlError | Schema.SchemaError) =>
    GoalScheduleStorageFailed.make({ reason: { _tag: "Storage" }, cause });
  const unencoded = (cause: Schema.SchemaError) =>
    GoalScheduleStorageFailed.make({ reason: { _tag: "Encode" }, cause });
  const rows =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
      Effect.flatMap(query, Schema.decodeUnknownEffect(Schema.Array(schema)));

  const schedules = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
    query.pipe(
      rows(ScheduleRow),
      Effect.map((found) => found.map(toSchedule)),
      Effect.mapError(failed),
    );
  const get = (goalInstanceId: string) =>
    Effect.map(
      schedules(
        sql`SELECT * FROM kanban_goal_schedules WHERE goal_instance_id = ${goalInstanceId}`,
      ),
      (found) => Option.fromUndefinedOr(found[0]),
    );
  const forProject = (projectId: string) =>
    schedules(
      sql`SELECT * FROM kanban_goal_schedules WHERE project_id = ${projectId} ORDER BY created_at`,
    );
  /** Dependency edges among the project's Goals. */
  const edges = (projectId: string) =>
    sql`SELECT d.goal_instance_id, d.depends_on FROM kanban_goal_dependencies d
        JOIN kanban_goal_schedules s ON s.goal_instance_id = d.goal_instance_id
        WHERE s.project_id = ${projectId} ORDER BY d.created_at, d.depends_on`.pipe(
      rows(DependencyRow),
      Effect.map((found): ReadonlyMap<string, readonly string[]> => {
        const map = new Map<string, string[]>();
        for (const row of found)
          map.set(row.goal_instance_id, [...(map.get(row.goal_instance_id) ?? []), row.depends_on]);
        return map;
      }),
      Effect.mapError(failed),
    );
  /** One update stamped with the current time. */
  const touch = (update: (at: number) => Effect.Effect<unknown, SqlError.SqlError>) =>
    Effect.flatMap(now, (at) => update(at).pipe(Effect.mapError(failed), Effect.asVoid));

  return {
    /** Records a Goal when its board starts; a restarted board keeps what was recorded. */
    register: Effect.fn("GoalSchedules.register")(function* (goal: {
      readonly goalInstanceId: string;
      readonly projectId: string;
      readonly targetBranch: string | null;
    }) {
      const at = yield* now;
      yield* sql`INSERT OR IGNORE INTO kanban_goal_schedules
          (goal_instance_id, project_id, priority, target_branch, upstream_pending, merge_json,
           verified_head, created_at, updated_at)
          VALUES (${goal.goalInstanceId}, ${goal.projectId}, 'normal', ${goal.targetBranch}, 0,
            NULL, NULL, ${at}, ${at})`.pipe(Effect.mapError(failed));
    }),

    get,
    forProject,
    edges,

    /** Every scheduled Goal, oldest first. */
    all: schedules(sql`SELECT * FROM kanban_goal_schedules ORDER BY created_at`),

    setPriority: (goalInstanceId: string, priority: GoalPriority) =>
      touch(
        (at) => sql`UPDATE kanban_goal_schedules SET priority = ${priority}, updated_at = ${at}
            WHERE goal_instance_id = ${goalInstanceId}`,
      ),

    /**
     * Replaces the Goals this Goal waits for. They must be other Goals of the same project, and no
     * Goal may end up waiting for itself through them.
     */
    setDependencies: Effect.fn("GoalSchedules.setDependencies")(function* (
      goalInstanceId: string,
      dependsOn: readonly string[],
    ) {
      const goal = yield* get(goalInstanceId);
      if (Option.isNone(goal)) return yield* GoalScheduleRefused.make({ reason: "goal_missing" });
      const wanted = [...new Set(dependsOn)];
      if (wanted.includes(goalInstanceId))
        return yield* GoalScheduleRefused.make({ reason: "self_dependency" });
      const project = new Set(
        (yield* forProject(goal.value.projectId)).map((s) => s.goalInstanceId),
      );
      for (const other of wanted) {
        const found = yield* get(other);
        if (Option.isNone(found))
          return yield* GoalScheduleRefused.make({ reason: "goal_missing" });
        if (!project.has(other))
          return yield* GoalScheduleRefused.make({ reason: "other_project" });
      }
      const current = new Map(yield* edges(goal.value.projectId));
      current.set(goalInstanceId, wanted);
      if (wanted.some((other) => reaches(current, other, goalInstanceId)))
        return yield* GoalScheduleRefused.make({ reason: "dependency_cycle" });
      const at = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM kanban_goal_dependencies WHERE goal_instance_id = ${goalInstanceId}`;
            for (const other of wanted)
              yield* sql`INSERT INTO kanban_goal_dependencies (goal_instance_id, depends_on, created_at)
                VALUES (${goalInstanceId}, ${other}, ${at})`;
          }),
        )
        .pipe(Effect.mapError(failed));
      return wanted;
    }),

    setMerge: Effect.fn("GoalSchedules.setMerge")(function* (
      goalInstanceId: string,
      state: GoalMergeState | null,
    ) {
      const json =
        state === null ? null : yield* encodeMerge(state).pipe(Effect.mapError(unencoded));
      yield* touch(
        (at) => sql`UPDATE kanban_goal_schedules SET merge_json = ${json}, updated_at = ${at}
            WHERE goal_instance_id = ${goalInstanceId}`,
      );
    }),

    setVerifiedHead: (goalInstanceId: string, head: string | null) =>
      touch(
        (at) => sql`UPDATE kanban_goal_schedules SET verified_head = ${head}, updated_at = ${at}
            WHERE goal_instance_id = ${goalInstanceId}`,
      ),

    setUpstreamPending: (goalInstanceId: string, pending: boolean) =>
      touch(
        (at) => sql`UPDATE kanban_goal_schedules SET upstream_pending = ${pending ? 1 : 0},
            updated_at = ${at} WHERE goal_instance_id = ${goalInstanceId}`,
      ),

    /** The project's protected branches; main and staging until the user picks. */
    protectedBranches: (projectId: string) =>
      sql`SELECT protected_branches_json FROM kanban_project_settings
          WHERE project_id = ${projectId}`.pipe(
        rows(SettingsRow),
        Effect.map((found): readonly string[] =>
          found[0] === undefined ? defaultProtectedBranches : found[0].protected_branches_json,
        ),
        Effect.mapError(failed),
      ),

    setProtectedBranches: Effect.fn("GoalSchedules.setProtectedBranches")(function* (
      projectId: string,
      branches: readonly string[],
    ) {
      const checked = yield* Schema.decodeEffect(ProtectedBranches)([...new Set(branches)]).pipe(
        Effect.mapError(() => GoalScheduleRefused.make({ reason: "invalid_branch" })),
      );
      const json = yield* encodeBranches(checked).pipe(Effect.mapError(unencoded));
      yield* sql`INSERT INTO kanban_project_settings (project_id, protected_branches_json)
          VALUES (${projectId}, ${json})
          ON CONFLICT(project_id) DO UPDATE SET protected_branches_json = excluded.protected_branches_json`.pipe(
        Effect.mapError(failed),
      );
      return checked;
    }),
  };
});

/** Kanban Goal schedules of the project scheduler. Owner process only. */
export class GoalSchedules extends Context.Service<GoalSchedules, Effect.Success<typeof make>>()(
  "memory-agent/kanban/goal-schedules/GoalSchedules",
) {
  static readonly layer = Layer.effect(GoalSchedules, make);
}
