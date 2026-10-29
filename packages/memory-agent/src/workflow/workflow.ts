import { isTruthy } from "../truthy.ts";
import { NodeCrypto } from "@effect/platform-node";
import {
  DateTime,
  Context,
  Crypto,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { optionalProperty } from "../optional-property.ts";
import { WorkflowActionReason } from "./actions.ts";
import {
  decodeGoalState,
  GoalEvent,
  goalStateOf,
  goalTransitions,
  reconciledPhase,
  type Standing,
  standingOf,
  stepsOf,
} from "./goal-transitions.ts";
import {
  completionEvidence,
  CompletionRequest,
  CompletionSnapshot,
  CriterionMapping,
  Derived,
} from "./completion-evidence.ts";
import {
  BoardAuthor,
  CardStatus,
  cardContract,
  cardContractFields,
  cardHoldFields,
  StepProgressStatus,
} from "./card.ts";
import { notStartedStatus, validatePlanDependencies } from "./plan-schedule.ts";
import {
  BoardEditRefused,
  BoardEditResult,
  closedPlan,
  planBoardEdit,
  planCardHold,
  planCardTransition,
  UserChange,
  type BoardEdit,
  type CardTransition,
  type UserChangeRequest,
} from "./board-edit.ts";
import { acknowledgedRunSql, resolvedRunSql } from "./run-bindings.ts";
import { logFailure } from "../runtime/logged-failures.ts";

export const WorkflowPhase = Schema.Literals([
  "chat",
  "goal",
  "plan",
  "execute",
  "verify",
  "completed",
]);
export type WorkflowPhase = typeof WorkflowPhase.Type;

export const WorkflowAction = Schema.Literals(["pause", "resume", "stop"]);
export type WorkflowAction = typeof WorkflowAction.Type;

const GoalQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  blocking: Schema.Boolean,
});

export const VerificationStatus = Schema.Literals([
  "not_run",
  "passed",
  "failed",
  "invalid_hypothesis",
  "invalid_criterion",
  "inconclusive",
  "blocked",
]);
export type VerificationStatus = typeof VerificationStatus.Type;

const Verification = Schema.Struct({
  status: VerificationStatus,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  recoveryPhase: Schema.NullOr(Schema.Literals(["goal", "plan"])).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  updatedAt: Schema.NullOr(Schema.String),
});
export type Verification = typeof Verification.Type;

const verificationDefault: Verification = {
  status: "not_run",
  summary: "",
  evidence: [],
  recoveryPhase: null,
  updatedAt: null,
};

const goalFields = {
  completion: Schema.optionalKey(CompletionSnapshot),
  completionRequest: Schema.optionalKey(CompletionRequest),
  version: Schema.Int,
  statement: Schema.String,
  outcomes: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  nonGoals: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  openQuestions: Schema.Array(GoalQuestion),
  evidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  verification: Verification.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(verificationDefault)),
  ),
  updatedAt: Schema.String,
} as const;

export const GoalArtifact = Schema.Struct({
  ...goalFields,
  status: Schema.Literals(["draft", "active", "paused", "completed", "failed"]),
});
export type GoalArtifact = typeof GoalArtifact.Type;

const planStepFields = {
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  ruleRefs: Schema.Array(Schema.String),
} as const;

const recordedEvidence = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
);

export const PlanStep = Schema.Struct({
  ...planStepFields,
  ...cardContractFields,
  ...cardHoldFields,
  status: CardStatus,
  evidence: recordedEvidence,
});
export type PlanStep = typeof PlanStep.Type;

// Plans saved before cards hold pending/completed; they are read, never rewritten in place.
const PersistedPlanStep = Schema.Struct({
  ...planStepFields,
  ...cardContractFields,
  ...cardHoldFields,
  status: Schema.Union([CardStatus, StepProgressStatus]),
  evidence: recordedEvidence,
});

/** Reads saved step statuses as cards: pending is ready, or backlog until its dependencies are done. */
const cardStatuses = <S extends typeof PersistedPlanStep.Type>(
  steps: readonly S[],
): Array<Omit<S, "status"> & { readonly status: CardStatus }> => {
  const done = new Set(
    steps
      .filter((step) => step.status === "done" || step.status === "completed")
      .map((step) => step.id),
  );
  const notStarted = notStartedStatus(steps, (id) => done.has(id));
  return steps.map((step) => ({
    ...step,
    status: Match.value(step.status).pipe(
      Match.withReturnType<CardStatus>(),
      Match.when("pending", () => notStarted(step)),
      Match.when("completed", () => "done"),
      Match.orElse((status) => status),
    ),
  }));
};

const planFields = {
  version: Schema.Int,
  goalVersion: Schema.Int,
  summary: Schema.String,
  steps: Schema.Array(PlanStep),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  verification: Verification.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(verificationDefault)),
  ),
  updatedAt: Schema.String,
} as const;

export const PlanArtifact = Schema.Struct({
  ...planFields,
  status: Schema.Literals(["draft", "ready", "executing", "completed", "blocked", "closed"]),
});
export type PlanArtifact = typeof PlanArtifact.Type;

const LedgerEvent = Schema.Struct({
  sequence: Schema.Int,
  at: Schema.String,
  kind: Schema.Literals([
    "phase_changed",
    "goal_updated",
    "plan_updated",
    "plan_replanned",
    "progress_updated",
    "goal_paused",
    "goal_resumed",
    "workflow_stopped",
    "verification_recorded",
    "verification_invalidated",
    "board_updated",
    "plan_closed",
  ]),
  detail: Schema.String,
});

export const WorkflowState = Schema.Struct({
  phase: WorkflowPhase,
  goal: Schema.NullOr(GoalArtifact),
  plan: Schema.NullOr(PlanArtifact),
  ledger: Schema.Array(LedgerEvent),
});
export type WorkflowState = typeof WorkflowState.Type;

/** A note the page shows beside the workflow state; see `Workflows.display`. */
export type WorkflowDisplay = "card_reclassifying";

export const UpdateGoal = Schema.Struct({
  statement: Schema.String,
  outcomes: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  nonGoals: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  openQuestions: Schema.Array(GoalQuestion),
  status: Schema.Literals(["draft", "active"]),
});
export type UpdateGoal = typeof UpdateGoal.Type;

/** A separate independent success criterion, never an implicit updateGoal interpretation. */
export const StartNewGoal = Schema.Struct({
  action: Schema.Literal("new_independent_goal"),
  previousGoalInstanceId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  goal: UpdateGoal,
});
export type StartNewGoal = typeof StartNewGoal.Type;

export class NewGoalTransitionRefused extends Schema.TaggedError<
  NewGoalTransitionRefused,
  { readonly brand: unique symbol }
>()("NewGoalTransitionRefused", {
  reason: Schema.Literals([
    "disabled",
    "phase_not_authorized",
    "goal_missing",
    "workflow_changed",
    "run_outcome_uncertain",
    "transition_pending",
    "owner_effect_uncertain",
    "execution_outstanding",
  ]),
}) {}

/** Where a run's queued new Goal stands once the owner settles it; `none` when it queued none. */
export type NewGoalSettlement = Data.TaggedEnum<{
  none: {};
  accepted: {};
  applied: { readonly goalInstanceId: string | null };
  rejected: { readonly reason: NewGoalTransitionRefused["reason"] | null };
}>;
export const NewGoalSettlement = Data.taggedEnum<NewGoalSettlement>();

export const UpdatePlan = Schema.Struct({
  summary: Schema.String,
  steps: Schema.Array(Schema.Struct(planStepFields)),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  status: Schema.Literals(["draft", "ready"]),
});
export type UpdatePlan = typeof UpdatePlan.Type;

const StepProgress = Schema.Struct({
  id: Schema.String,
  status: StepProgressStatus,
  evidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
});

const VerificationUpdate = Schema.Struct({
  status: VerificationStatus,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  recoveryPhase: Schema.optionalKey(Schema.NullOr(Schema.Literals(["goal", "plan"]))),
});

export const UpdateWorkflowProgress = Schema.Struct({
  criterionMappings: Schema.optionalKey(Schema.Array(CriterionMapping)),
  goalStatus: Schema.optionalKey(Schema.Literals(["active", "paused", "completed", "failed"])),
  planStatus: Schema.optionalKey(Schema.Literals(["executing", "completed", "blocked"])),
  steps: Schema.Array(StepProgress).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  goalEvidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  planEvidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  verification: Schema.optionalKey(VerificationUpdate),
  detail: Schema.String,
});
export type UpdateWorkflowProgress = typeof UpdateWorkflowProgress.Type;

const emptyState = (): WorkflowState => ({ phase: "chat", goal: null, plan: null, ledger: [] });

// Read workflow rows written before execution state and evidence became durable fields.
const PersistedGoalArtifact = Schema.Struct({
  ...goalFields,
  status: Schema.Literals([
    "draft",
    "ready",
    "confirmed",
    "active",
    "paused",
    "completed",
    "failed",
  ]),
});
const PersistedPlanArtifact = Schema.Struct({
  ...planFields,
  steps: Schema.Array(PersistedPlanStep),
  status: Schema.Literals([
    "draft",
    "ready",
    "approved",
    "executing",
    "completed",
    "blocked",
    "closed",
  ]),
});
const PersistedWorkflowState = Schema.Struct({
  phase: WorkflowPhase,
  goal: Schema.NullOr(PersistedGoalArtifact),
  plan: Schema.NullOr(PersistedPlanArtifact),
  ledger: Schema.Array(LedgerEvent),
});
export const decodeWorkflowState = (json: string) =>
  Schema.decodeEffect(Schema.fromJsonString(PersistedWorkflowState))(json).pipe(
    Effect.map((state): WorkflowState => ({
      ...state,
      goal:
        state.goal === null
          ? null
          : {
              ...state.goal,
              status:
                state.goal.status === "ready" || state.goal.status === "confirmed"
                  ? "active"
                  : state.goal.status,
            },
      plan:
        state.plan === null
          ? null
          : {
              ...state.plan,
              steps: cardStatuses(state.plan.steps),
              status: state.plan.status === "approved" ? "executing" : state.plan.status,
            },
    })),
  );
const encodeState = Schema.encodeEffect(Schema.fromJsonString(WorkflowState));
const encodeAuthor = Schema.encodeEffect(Schema.fromJsonString(BoardAuthor));
const encodeChange = Schema.encodeEffect(Schema.fromJsonString(UserChange));

/** The workflow store could not be read or written; the cause stays with the error. */
export class WorkflowStorageError extends Schema.TaggedError<
  WorkflowStorageError,
  { readonly brand: unique symbol }
>()("WorkflowStorageError", { cause: Schema.Defect() }) {}
const persisted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error: E): error is Extract<E, SqlError.SqlError | Schema.SchemaError> =>
      Predicate.isTagged(error, "SqlError") || Predicate.isTagged(error, "SchemaError"),
    (cause) => Effect.fail(WorkflowStorageError.make({ cause })),
  );
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(StartNewGoal));
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(StartNewGoal));
const sameSnapshot = Schema.toEquivalence(CompletionSnapshot);

export class WorkflowTransitionRefused extends Schema.TaggedError<
  WorkflowTransitionRefused,
  { readonly brand: unique symbol }
>()("WorkflowTransitionRefused", { reason: WorkflowActionReason }) {}

export class WorkflowProgressRefused extends Schema.TaggedError<
  WorkflowProgressRefused,
  { readonly brand: unique symbol }
>()("WorkflowProgressRefused", {
  reason: Schema.Union([
    WorkflowActionReason,
    Schema.Literals([
      "plan_missing",
      "unknown_step",
      "step_evidence_required",
      "verification_required",
      "steps_incomplete",
      "phase_not_executable",
      "goal_completion_required",
      "completion_evidence_required",
      "completion_evidence_invalid",
      "completion_snapshot_conflict",
    ]),
  ]),
}) {}

/** `state` with the phase and statuses `standing` decided; a changed artifact is stamped `at`. */
const withStanding = (state: WorkflowState, standing: Standing, at: string): WorkflowState => ({
  ...state,
  phase: standing.phase,
  goal:
    state.goal === null || standing.goal === null || standing.goal.status === state.goal.status
      ? state.goal
      : { ...state.goal, status: standing.goal.status, updatedAt: at },
  plan:
    state.plan === null || standing.plan === null || standing.plan.status === state.plan.status
      ? state.plan
      : { ...state.plan, status: standing.plan.status, updatedAt: at },
});
const unchanged = (next: WorkflowState, current: WorkflowState) =>
  next.phase === current.phase && next.goal === current.goal && next.plan === current.plan;

const make = (options: { readonly allowNewGoal?: boolean } = {}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sql = yield* SqlClient.SqlClient;
    const completion = yield* completionEvidence;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    /**
     * One session's read-modify-write commits or rolls back as a whole. The transaction holds the
     * one connection, so it already runs alone; a key lock around it would deadlock a caller that
     * opened the transaction first.
     */
    const transacted = <A, E>(effect: Effect.Effect<A, E>) =>
      persisted(sql.withTransaction(effect));
    const selectState = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ state_json: Schema.String }),
      execute: (sessionId) =>
        sql`SELECT state_json FROM session_workflows WHERE session_id = ${sessionId}`,
    });
    const goalIdentity = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ goal_instance_id: Schema.String }),
      execute: (sessionId) =>
        sql`SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}`,
    });
    const latestRevision = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ id: Schema.Finite }),
      execute: (sessionId) => sql`SELECT id FROM workflow_state_revisions
        WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`,
    });
    const runOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ thread_id: Schema.String, status: Schema.String }),
      execute: (runId) => sql`SELECT thread_id, status FROM chat_runs WHERE run_id = ${runId}`,
    });
    const bindingOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({
        session_id: Schema.String,
        goal_instance_id: Schema.String,
        workflow_revision_id: Schema.Finite,
      }),
      execute: (runId) => sql`SELECT session_id, goal_instance_id, workflow_revision_id
        FROM workflow_run_bindings WHERE run_id = ${runId}`,
    });
    const requestOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ payload_json: Schema.String, status: Schema.String }),
      execute: (runId) =>
        sql`SELECT payload_json, status FROM workflow_new_goal_requests WHERE run_id = ${runId}`,
    });
    const settlementOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({
        session_id: Schema.String,
        payload_json: Schema.String,
        source_revision_id: Schema.Finite,
        status: Schema.Literals(["accepted", "applied", "rejected"]),
        reason: Schema.NullOr(NewGoalTransitionRefused.fields.reason),
        applied_goal_instance_id: Schema.NullOr(Schema.String),
      }),
      execute: (runId) => sql`SELECT session_id, payload_json, source_revision_id, status, reason,
        applied_goal_instance_id FROM workflow_new_goal_requests WHERE run_id = ${runId}`,
    });
    const exists = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
      Effect.map(statement, (rows) => rows.length > 0);
    const pendingNewGoal = (sessionId: string) =>
      exists(sql`SELECT run_id FROM workflow_new_goal_requests
        WHERE session_id = ${sessionId} AND status = 'accepted' LIMIT 1`);
    const insertGoalIdentity = (sessionId: string, goalInstanceId: string, now: string) =>
      sql`INSERT INTO workflow_goal_identities (session_id, goal_instance_id, created_at)
        VALUES (${sessionId}, ${goalInstanceId}, ${now})`;

    const get = (sessionId: string) =>
      selectState(sessionId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(emptyState()),
            onSome: (row) => decodeWorkflowState(row.state_json),
          }),
        ),
      );
    /** Board changes name their author; phase, Goal and lifecycle saves record none. */
    const save = Effect.fnUntraced(function* (
      sessionId: string,
      state: WorkflowState,
      author?: BoardAuthor,
    ) {
      const now = yield* nowIso;
      const json = yield* encodeState(state);
      const authorJson = author === undefined ? null : yield* encodeAuthor(author);
      yield* sql`INSERT INTO session_workflows (session_id, state_json, updated_at)
        VALUES (${sessionId}, ${json}, ${now})
        ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`;
      yield* sql`INSERT INTO workflow_state_revisions
        (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id,
         author_json)
        VALUES (${sessionId}, ${json}, ${state.goal?.version ?? null}, ${state.plan?.version ?? null},
          'recorded', ${now},
          (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}),
          ${authorJson})`;
      return state;
    });
    const change = <E>(
      sessionId: string,
      update: (current: WorkflowState) => Effect.Effect<WorkflowState, E>,
      author?: BoardAuthor,
    ) =>
      transacted(
        Effect.gen(function* () {
          const current = yield* get(sessionId);
          const next = yield* update(current);
          return next === current ? current : yield* save(sessionId, next, author);
        }),
      );
    /** Whether the session's current Goal runs as an active kanban board. */
    const kanbanBoard = (sessionId: string) =>
      exists(sql`SELECT 1 AS active FROM kanban_goals k JOIN workflow_goal_identities g
        ON g.goal_instance_id = k.goal_instance_id
        WHERE g.session_id = ${sessionId} AND k.status = 'active'`);
    const event = (
      state: WorkflowState,
      kind: (typeof LedgerEvent.Type)["kind"],
      detail: string,
      at: string,
    ) => ({
      sequence: (state.ledger.at(-1)?.sequence ?? 0) + 1,
      at,
      kind,
      detail,
    });
    /** The state after a Plan ends without completion; the transition decided its `phase`. */
    const closing = (
      current: WorkflowState,
      plan: PlanArtifact,
      detail: string,
      at: string,
      phase: WorkflowPhase,
    ): WorkflowState => {
      const closed: WorkflowState = {
        ...current,
        phase,
        plan: { ...plan, updatedAt: at },
        ledger: [...current.ledger, event(current, "plan_closed", detail, at)],
      };
      return phase === current.phase
        ? closed
        : {
            ...closed,
            ledger: [
              ...closed.ledger,
              event(closed, "phase_changed", `${current.phase} -> ${phase} (plan closed)`, at),
            ],
          };
    };
    /** The state of `current`, a conflict 0.0.17 left repaired in memory. */
    const goalState = (current: WorkflowState) => goalStateOf(standingOf(current));
    /** `current` with a conflict repaired and a stale progress position corrected, saved if changed. */
    const reconciled = Effect.fnUntraced(function* (sessionId: string, current: WorkflowState) {
      const repaired = goalState(current).standing;
      const phase = reconciledPhase(repaired);
      const now = yield* nowIso;
      const next = withStanding(current, { ...repaired, phase }, now);
      if (unchanged(next, current)) return current;
      return yield* save(sessionId, {
        ...next,
        ledger: [
          ...next.ledger,
          event(current, "phase_changed", `${current.phase} -> ${phase} (state reconciled)`, now),
        ],
      });
    });
    /** Whether a verify run's completion evidence holds, and the snapshot that completes the Goal. */
    const finishedCompletion = Effect.fnUntraced(function* (
      sessionId: string,
      current: WorkflowState,
    ) {
      const { goal, plan } = current;
      const request = goal?.completionRequest;
      const derived =
        request !== undefined &&
        goal !== null &&
        plan !== null &&
        request.goalVersion === goal.version &&
        request.planVersion === plan.version
          ? yield* completion.derive(sessionId, current, request.mappings, request.recorderRunId)
          : undefined;
      const snapshot =
        derived !== undefined && Derived.$is("accepted")(derived)
          ? derived.snapshot
          : goal?.completion;
      // Native registration authorizes execution, not successful criterion coverage.
      // Legacy/unprovenanced Goals retain the release-compatible automatic completion.
      const recorded =
        !(yield* completion.required(sessionId)) ||
        (isTruthy(snapshot) &&
          snapshot.goalVersion === goal?.version &&
          snapshot.planVersion === plan?.version);
      return { recorded, snapshot };
    });

    const refuseNewGoal = (reason: NewGoalTransitionRefused["reason"]) =>
      Effect.fail(NewGoalTransitionRefused.make({ reason }));
    // Used both at tool admission and again at the completed-run owner boundary.
    // Only admission may exclude its own (still running) run; application excludes none.
    const checkNewGoal = Effect.fnUntraced(function* (
      sessionId: string,
      input: StartNewGoal,
      request: Extract<GoalEvent, { readonly _tag: "NewGoalRequested" | "NewGoalStarted" }>,
      callingRunId?: string,
    ) {
      if (options.allowNewGoal === false) return yield* refuseNewGoal("disabled");
      const current = yield* get(sessionId);
      const state = goalState(current);
      const source = Match.valueTags(request, {
        NewGoalRequested: (requested) => goalTransitions.NewGoalRequested(state, requested),
        NewGoalStarted: (started) => goalTransitions.NewGoalStarted(state, started),
      });
      if (source._tag === "Refused") return yield* refuseNewGoal(source.reason);
      const identity = yield* goalIdentity(sessionId);
      if (
        Option.getOrNull(Option.map(identity, (row) => row.goal_instance_id)) !==
        input.previousGoalInstanceId
      )
        return yield* refuseNewGoal("workflow_changed");
      const caller = callingRunId ?? "";
      if (
        (yield* exists(sql`
          SELECT b.run_id FROM workflow_run_bindings b LEFT JOIN chat_runs r ON r.run_id = b.run_id
          WHERE b.session_id = ${sessionId} AND b.run_id <> ${caller}
            AND (r.status IS NULL OR r.status <> 'completed')
            AND NOT ${sql.literal(resolvedRunSql("b", "r"))} LIMIT 1`)) ||
        (yield* exists(sql`
          SELECT r.run_id FROM chat_runs r WHERE r.thread_id = ${sessionId} AND r.run_id <> ${caller}
            AND r.status <> 'completed'
            AND NOT EXISTS (SELECT 1 FROM workflow_run_bindings b
              WHERE b.run_id = r.run_id AND ${sql.literal(resolvedRunSql("b", "r"))}) LIMIT 1`))
      )
        return yield* refuseNewGoal("run_outcome_uncertain");
      if (
        yield* exists(sql`
          SELECT o.run_id FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id = o.run_id
          WHERE b.session_id = ${sessionId}
            AND ((o.status = 'pending' AND o.run_id <> ${caller}) OR (o.side_effect = 1 AND o.status = 'uncertain'))
            AND NOT ${sql.literal(acknowledgedRunSql("b"))} LIMIT 1`)
      )
        return yield* refuseNewGoal("owner_effect_uncertain");
      if (
        yield* exists(sql`SELECT id FROM work_tasks WHERE origin_session_id = ${sessionId}
          AND status NOT IN ('completed', 'archived') LIMIT 1`)
      )
        return yield* refuseNewGoal("execution_outstanding");
      return { current, identity, standing: source.standing };
    });
    const commitNewGoal = Effect.fnUntraced(function* (sessionId: string, input: StartNewGoal) {
      const { current, identity, standing } = yield* checkNewGoal(
        sessionId,
        input,
        GoalEvent.NewGoalStarted({ status: input.goal.status }),
      );
      const now = yield* nowIso;
      const newId = yield* crypto.randomUUIDv4();
      // An unbound legacy Goal never receives a fabricated historical identity.
      yield* Option.isSome(identity)
        ? Effect.andThen(
            sql`INSERT INTO workflow_goal_instances VALUES (${newId}, ${sessionId}, ${now})`,
            sql`UPDATE workflow_goal_identities SET goal_instance_id = ${newId}, created_at = ${now}
              WHERE session_id = ${sessionId}`,
          )
        : insertGoalIdentity(sessionId, newId, now);
      const state = yield* save(sessionId, {
        phase: standing.phase,
        goal: {
          ...input.goal,
          version: 1,
          evidence: [],
          verification: verificationDefault,
          updatedAt: now,
        },
        plan: null,
        ledger: [
          ...current.ledger,
          event(
            current,
            "goal_updated",
            `explicit new Goal ${newId}; prior ${input.previousGoalInstanceId ?? "legacy/unbound"}; ${input.reason}`,
            now,
          ),
        ],
      });
      return { state, newId };
    });
    /**
     * Idempotent owner settlement of a run's new Goal request. A run `waiting` may still finish, so
     * its request stays accepted; a failed or missing run can never apply its intent.
     */
    const settleRequest = (
      sessionId: string,
      runId: string,
      waiting: (run: { readonly status: string }) => boolean,
    ) =>
      transacted(
        Effect.gen(function* () {
          const found = yield* settlementOf(runId);
          if (Option.isNone(found) || found.value.session_id !== sessionId)
            return NewGoalSettlement.none();
          const row = found.value;
          if (row.status === "applied")
            return NewGoalSettlement.applied({ goalInstanceId: row.applied_goal_instance_id });
          if (row.status === "rejected") return NewGoalSettlement.rejected({ reason: row.reason });
          const run = Option.getOrUndefined(yield* runOf(runId));
          if (run?.thread_id === sessionId && waiting(run)) return NewGoalSettlement.accepted();
          const reject = (reason: NewGoalTransitionRefused["reason"]) =>
            nowIso.pipe(
              Effect.flatMap(
                (
                  now,
                ) => sql`UPDATE workflow_new_goal_requests SET status = 'rejected', reason = ${reason},
              settled_at = ${now} WHERE run_id = ${runId} AND status = 'accepted'`,
              ),
              Effect.as(NewGoalSettlement.rejected({ reason })),
            );
          if (run?.thread_id !== sessionId || run.status !== "completed")
            return yield* reject("run_outcome_uncertain");
          const latest = yield* latestRevision(sessionId);
          if (Option.getOrUndefined(latest)?.id !== row.source_revision_id)
            return yield* reject("workflow_changed");
          const input = yield* decodeRequest(row.payload_json);
          return yield* commitNewGoal(sessionId, input).pipe(
            Effect.flatMap(({ newId }) =>
              nowIso.pipe(
                Effect.flatMap(
                  (now) => sql`UPDATE workflow_new_goal_requests
                SET status = 'applied', applied_goal_instance_id = ${newId}, settled_at = ${now}
                WHERE run_id = ${runId} AND status = 'accepted'`,
                ),
                Effect.as(NewGoalSettlement.applied({ goalInstanceId: newId })),
              ),
            ),
            Effect.catchTag("NewGoalTransitionRefused", (error) => reject(error.reason)),
          );
        }),
      );
    const storedStates = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ session_id: Schema.String, state_json: Schema.String }),
      execute: () => sql`SELECT session_id, state_json FROM session_workflows ORDER BY session_id`,
    });
    const acceptedRequests = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ session_id: Schema.String, run_id: Schema.String }),
      execute: () => sql`SELECT session_id, run_id FROM workflow_new_goal_requests
        WHERE status = 'accepted' ORDER BY run_id`,
    });

    /** The standing after a board change to `plan`; `closes` when it ends the Plan. */
    const boardEdited = (current: WorkflowState, plan: PlanArtifact, closes: boolean) => {
      const outcome = goalTransitions.BoardEdited(
        goalState(current),
        GoalEvent.BoardEdited({ closes, ...stepsOf(plan.steps) }),
      );
      return outcome._tag === "Refused"
        ? Effect.fail(BoardEditRefused.make({ reason: outcome.reason }))
        : Effect.succeed(outcome.standing);
    };
    /** `current` with a board change to its cards, recorded in the ledger. */
    const boardChanged = (
      current: WorkflowState,
      planned: { readonly plan: PlanArtifact; readonly detail: string },
      at: string,
    ) =>
      Effect.map(boardEdited(current, planned.plan, false), (standing) =>
        withStanding(
          {
            ...current,
            plan: { ...planned.plan, updatedAt: at },
            ledger: [...current.ledger, event(current, "board_updated", planned.detail, at)],
          },
          standing,
          at,
        ),
      );

    return {
      get: (sessionId: string) => persisted(get(sessionId)),
      goalInstanceId: (sessionId: string) =>
        persisted(
          goalIdentity(sessionId).pipe(
            Effect.map((row) =>
              Option.getOrNull(Option.map(row, (found) => found.goal_instance_id)),
            ),
          ),
        ),

      /** Repairs stale persisted phases before a new turn or an idle status response. */
      reconcile: (sessionId: string) =>
        transacted(Effect.flatMap(get(sessionId), (current) => reconciled(sessionId, current))),

      /**
       * What the page says beside `state` that the state alone does not show: a kanban Goal edit
       * keeps the phase while the orchestrator sorts the cards again for the new Goal version.
       */
      display: (
        sessionId: string,
        state: WorkflowState,
      ): Effect.Effect<WorkflowDisplay | null, WorkflowStorageError> =>
        goalStateOf(standingOf(state))._tag === "GoalChanged"
          ? Effect.map(persisted(kanbanBoard(sessionId)), (kanban) =>
              kanban ? "card_reclassifying" : null,
            )
          : Effect.succeed(null),

      /**
       * Repairs every session whose stored Goal and Plan no transition makes, and returns their ids.
       * An active kanban board's orchestrator still uses its Plan, so its session is only logged.
       */
      checkAll: persisted(storedStates()).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, ({ session_id: sessionId, state_json: json }) =>
            decodeWorkflowState(json).pipe(
              Effect.flatMap((current) =>
                Result.isSuccess(decodeGoalState(standingOf(current)))
                  ? Effect.succeed([])
                  : Effect.flatMap(persisted(kanbanBoard(sessionId)), (kanban) =>
                      kanban
                        ? Effect.as(
                            Effect.logWarning("Kanban Goal left in a conflicting state", {
                              sessionId,
                            }),
                            [],
                          )
                        : Effect.as(
                            transacted(
                              Effect.flatMap(get(sessionId), (stored) =>
                                reconciled(sessionId, stored),
                              ),
                            ),
                            [sessionId],
                          ),
                    ),
              ),
              Effect.catch((error) =>
                Effect.as(
                  logFailure("Workflow state unreadable at startup", { sessionId })(error),
                  [],
                ),
              ),
            ),
          ),
        ),
        Effect.map((repaired) => repaired.flat()),
      ),

      setPhase: (sessionId: string, phase: WorkflowPhase) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const state = goalState(current);
            const outcome =
              phase === "execute"
                ? goalTransitions.ExecutionApproved(state, GoalEvent.ExecutionApproved())
                : goalTransitions.Navigated(state, GoalEvent.Navigated({ phase }));
            if (outcome._tag === "Refused")
              return yield* WorkflowTransitionRefused.make({ reason: outcome.reason });
            const now = yield* nowIso;
            const next = withStanding(current, outcome.standing, now);
            return yield* save(sessionId, {
              ...next,
              ledger: [
                ...next.ledger,
                event(current, "phase_changed", `${current.phase} -> ${phase}`, now),
              ],
            });
          }),
        ),

      controlGoal: (sessionId: string, action: WorkflowAction) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const state = goalState(current);
            const outcome = Match.value(action).pipe(
              Match.when("pause", () => goalTransitions.GoalPaused(state, GoalEvent.GoalPaused())),
              Match.when("resume", () =>
                goalTransitions.GoalResumed(state, GoalEvent.GoalResumed()),
              ),
              Match.when("stop", () => goalTransitions.GoalStopped(state, GoalEvent.GoalStopped())),
              Match.exhaustive,
            );
            if (outcome._tag === "Refused")
              return yield* WorkflowProgressRefused.make({ reason: outcome.reason });
            const now = yield* nowIso;
            const kind =
              action === "pause"
                ? "goal_paused"
                : action === "resume"
                  ? "goal_resumed"
                  : "workflow_stopped";
            const detail =
              action === "pause"
                ? "Paused by the user"
                : action === "resume"
                  ? "Resumed by the user"
                  : "Stopped by the user";
            const next = withStanding(current, outcome.standing, now);
            return yield* save(sessionId, {
              ...next,
              ledger: [...next.ledger, event(current, kind, detail, now)],
            });
          }),
        ),

      finishRun: (sessionId: string, startedPhase: WorkflowPhase) =>
        change(sessionId, (current) =>
          Effect.gen(function* () {
            const now = yield* nowIso;
            const finished =
              startedPhase === "verify"
                ? yield* finishedCompletion(sessionId, current)
                : { recorded: false, snapshot: undefined };
            const { standing } = goalTransitions.RunFinished(
              goalState(current),
              GoalEvent.RunFinished({ startedPhase, completionRecorded: finished.recorded }),
            );
            const next = withStanding(current, standing, now);
            if (unchanged(next, current)) return current;
            if (next.plan?.status === "completed" && current.plan?.status !== "completed")
              return {
                ...next,
                goal:
                  next.goal === null
                    ? null
                    : {
                        ...next.goal,
                        verification: current.plan?.verification ?? next.goal.verification,
                        ...optionalProperty("completion", finished.snapshot),
                      },
                ledger: [
                  ...next.ledger,
                  event(current, "progress_updated", "Verification completed the workflow", now),
                ],
              };
            if (next.phase === current.phase) return next;
            const cause =
              startedPhase === "verify" ? ` (${current.plan?.verification.status})` : "";
            return {
              ...next,
              ledger: [
                ...next.ledger,
                event(current, "phase_changed", `${current.phase} -> ${next.phase}${cause}`, now),
              ],
            };
          }),
        ),

      /** Direct owner transition requires a fully quiescent session. */
      startNewGoal: (sessionId: string, input: StartNewGoal) =>
        transacted(
          Effect.gen(function* () {
            if (yield* pendingNewGoal(sessionId)) return yield* refuseNewGoal("transition_pending");
            return (yield* commitNewGoal(sessionId, input)).state;
          }),
        ),

      /** Tool admission only records a durable request; never claims a new Goal was saved. */
      requestNewGoal: (sessionId: string, runId: string, input: StartNewGoal) =>
        transacted(
          Effect.gen(function* () {
            const payload = yield* encodeRequest(input);
            const existing = yield* requestOf(runId);
            if (Option.isSome(existing)) {
              // Compare canonical encodings so a request stored with another key order still matches.
              const stored = yield* encodeRequest(
                yield* decodeRequest(existing.value.payload_json),
              );
              if (stored === payload && existing.value.status === "accepted")
                return { status: "accepted" as const, runId };
              return yield* refuseNewGoal("transition_pending");
            }
            const run = Option.getOrUndefined(yield* runOf(runId));
            if (!(runId.length > 0) || run?.thread_id !== sessionId || run.status !== "running")
              return yield* refuseNewGoal("run_outcome_uncertain");
            if (yield* pendingNewGoal(sessionId)) return yield* refuseNewGoal("transition_pending");
            yield* checkNewGoal(sessionId, input, GoalEvent.NewGoalRequested(), runId);
            const binding = Option.getOrUndefined(yield* bindingOf(runId));
            const revision = yield* latestRevision(sessionId);
            if (
              Option.isNone(revision) ||
              (binding !== undefined &&
                (binding.session_id !== sessionId ||
                  binding.goal_instance_id !== input.previousGoalInstanceId ||
                  binding.workflow_revision_id !== revision.value.id))
            )
              return yield* refuseNewGoal("workflow_changed");
            yield* sql`INSERT INTO workflow_new_goal_requests
            (run_id, session_id, previous_goal_instance_id, source_revision_id,
             payload_json, status, created_at)
            VALUES (${runId}, ${sessionId}, ${input.previousGoalInstanceId}, ${revision.value.id},
              ${payload}, 'accepted', ${yield* nowIso})`;
            return { status: "accepted" as const, runId };
          }),
        ).pipe(
          Effect.tapErrorTag("NewGoalTransitionRefused", ({ reason }) =>
            Effect.logWarning("New Goal request refused", { sessionId, runId, reason }),
          ),
        ),

      /** Idempotent owner settlement. A failed or missing run can never apply its intent. */
      settleNewGoalRequest: (sessionId: string, runId: string) =>
        settleRequest(
          sessionId,
          runId,
          // A run waiting for an approval in this process settles once it finishes.
          ({ status }) => status === "running" || status === "interrupted",
        ),

      /**
       * Settles every accepted request at startup. No run of an earlier process can still finish, so
       * only a completed run applies its request. Returns how many were settled.
       */
      settleAbandonedNewGoalRequests: persisted(acceptedRequests()).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, ({ session_id: sessionId, run_id: runId }) =>
            settleRequest(sessionId, runId, () => false),
          ),
        ),
        Effect.map((settled) => settled.length),
      ),

      updateGoal: (sessionId: string, input: UpdateGoal) =>
        change(sessionId, (current) =>
          Effect.gen(function* () {
            const now = yield* nowIso;
            // Only the first Goal in a new session is unambiguously new. A legacy Goal
            // without a recorded identity stays unbound; guessing it from text is unsafe.
            yield* Effect.when(
              Effect.flatMap(crypto.randomUUIDv4(), (goalInstanceId) =>
                insertGoalIdentity(sessionId, goalInstanceId, now),
              ),
              Effect.succeed(current.goal === null),
            );
            const goal: GoalArtifact = {
              ...input,
              evidence: [],
              verification: verificationDefault,
              version: (current.goal?.version ?? 0) + 1,
              updatedAt: now,
            };
            // A kanban board keeps executing: its orchestrator classifies each card against the new
            // Goal instead (docs/kanban-orchestration.md "식별자와 Goal 변경").
            const { standing } = goalTransitions.GoalEdited(
              goalState(current),
              GoalEvent.GoalEdited({ status: input.status, kanban: yield* kanbanBoard(sessionId) }),
            );
            const revised = withStanding(
              {
                ...current,
                goal,
                ledger: [
                  ...current.ledger,
                  event(current, "goal_updated", `goal v${goal.version} (${goal.status})`, now),
                ],
              },
              standing,
              now,
            );
            return revised.phase === current.phase
              ? revised
              : {
                  ...revised,
                  ledger: [
                    ...revised.ledger,
                    event(
                      revised,
                      "phase_changed",
                      `${current.phase} -> ${revised.phase} (goal revised)`,
                      now,
                    ),
                  ],
                };
          }),
        ),

      updatePlan: (sessionId: string, input: UpdatePlan, author?: BoardAuthor) =>
        validatePlanDependencies(input.steps).pipe(
          Effect.andThen(() =>
            change(
              sessionId,
              (current) =>
                Effect.map(nowIso, (now) => {
                  const previous = new Map(
                    current.plan?.steps.map((step) => [step.id, step]) ?? [],
                  );
                  const plan: PlanArtifact = {
                    ...input,
                    steps: cardStatuses(
                      input.steps.map((step) => {
                        const replanned = { ...step, status: "pending" as const, evidence: [] };
                        const prior = previous.get(step.id);
                        return prior === undefined
                          ? replanned
                          : {
                              ...cardContract(prior),
                              ...optionalProperty("hold", prior.hold),
                              ...replanned,
                            };
                      }),
                    ),
                    evidence: [],
                    verification: verificationDefault,
                    version: (current.plan?.version ?? 0) + 1,
                    goalVersion: current.goal?.version ?? 0,
                    updatedAt: now,
                  };
                  const { standing } = goalTransitions.PlanEdited(
                    goalState(current),
                    GoalEvent.PlanEdited({ status: input.status, ...stepsOf(plan.steps) }),
                  );
                  const kind = current.plan === null ? "plan_updated" : "plan_replanned";
                  const planned = withStanding(
                    {
                      ...current,
                      plan,
                      ledger: [
                        ...current.ledger,
                        event(current, kind, `plan v${plan.version} (${plan.status})`, now),
                      ],
                    },
                    standing,
                    now,
                  );
                  return planned.phase === current.phase
                    ? planned
                    : {
                        ...planned,
                        ledger: [
                          ...planned.ledger,
                          event(
                            planned,
                            "phase_changed",
                            `${current.phase} -> ${planned.phase} (plan revised)`,
                            now,
                          ),
                        ],
                      };
                }),
              author,
            ),
          ),
        ),

      updateProgress: (
        sessionId: string,
        input: UpdateWorkflowProgress,
        recorderRunId = "",
        author?: BoardAuthor,
      ) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            // Progress names a step in the model's vocabulary; an untouched card keeps its column.
            const steps = cardStatuses(
              current.plan?.steps.map((step) => {
                const update = input.steps.find((candidate) => candidate.id === step.id);
                return isTruthy(update)
                  ? {
                      ...step,
                      status: update.status,
                      evidence: [...step.evidence, ...update.evidence],
                    }
                  : step;
              }) ?? [],
            );
            const verification = isTruthy(input.verification)
              ? {
                  ...input.verification,
                  recoveryPhase: input.verification.recoveryPhase ?? null,
                  updatedAt: yield* nowIso,
                }
              : null;
            // The ledger holds a running recorder's own calls as pending until the run settles.
            const stageCompletion = yield* completion.running(recorderRunId);
            const outcome = goalTransitions.ProgressRecorded(
              goalState(current),
              GoalEvent.ProgressRecorded({
                goalStatus: input.goalStatus ?? null,
                planStatus: input.planStatus ?? null,
                staged: stageCompletion,
                unknownStep: input.steps.some(
                  (update) => !isTruthy(current.plan?.steps.some((step) => step.id === update.id)),
                ),
                stepsUpdated: input.steps.length > 0,
                stepEvidenceMissing: steps.some(
                  (step) => step.status === "done" && step.evidence.length === 0,
                ),
                ...stepsOf(steps),
                planEvidence: input.planEvidence.length > 0,
                verification:
                  verification === null
                    ? null
                    : {
                        status: verification.status,
                        evidence: verification.evidence.length > 0,
                        recoveryPhase: verification.recoveryPhase,
                      },
              }),
            );
            if (outcome._tag === "Refused")
              return yield* WorkflowProgressRefused.make({ reason: outcome.reason });
            const goalVerification = verification ?? current.goal?.verification;

            const mappings = input.criterionMappings;
            const derived =
              mappings === undefined
                ? undefined
                : yield* completion.derive(
                    sessionId,
                    {
                      ...current,
                      plan: isTruthy(current.plan) ? { ...current.plan, steps } : null,
                    },
                    mappings,
                    recorderRunId,
                    stageCompletion,
                  );
            if (derived !== undefined && Derived.$is("refused")(derived))
              return yield* WorkflowProgressRefused.make({
                reason: "completion_evidence_invalid",
              });
            const recorded = current.goal?.completion;
            if (
              derived !== undefined &&
              isTruthy(recorded) &&
              !sameSnapshot(recorded, derived.snapshot)
            )
              return yield* WorkflowProgressRefused.make({
                reason: "completion_snapshot_conflict",
              });
            if (
              derived !== undefined &&
              (goalVerification?.status !== "passed" || goalVerification.evidence.length === 0)
            )
              return yield* WorkflowProgressRefused.make({ reason: "verification_required" });
            // A run still recording completion stages its mappings; otherwise they settle now.
            const completionRequest =
              derived !== undefined && mappings !== undefined && stageCompletion
                ? {
                    recorderRunId,
                    goalVersion: derived.snapshot.goalVersion,
                    planVersion: derived.snapshot.planVersion,
                    mappings,
                  }
                : current.goal?.completionRequest;
            const snapshot =
              derived !== undefined && !stageCompletion ? derived.snapshot : recorded;
            if (
              input.goalStatus === "completed" &&
              (yield* completion.required(sessionId)) &&
              !stageCompletion
            ) {
              if (!isTruthy(snapshot))
                return yield* WorkflowProgressRefused.make({
                  reason: "completion_evidence_required",
                });
              const checked = yield* completion.derive(
                sessionId,
                {
                  ...current,
                  plan: isTruthy(current.plan) ? { ...current.plan, steps } : null,
                },
                snapshot.mappings,
                recorderRunId,
              );
              if (Derived.$is("refused")(checked) || !sameSnapshot(checked.snapshot, snapshot))
                return yield* WorkflowProgressRefused.make({
                  reason: "completion_evidence_invalid",
                });
            }
            const now = yield* nowIso;
            const recordGoalVerification =
              verification !== null &&
              (input.goalStatus !== undefined ||
                current.phase === "goal" ||
                current.phase === "verify" ||
                current.plan === null);
            const recordPlanVerification =
              verification !== null &&
              (input.planStatus !== undefined ||
                current.phase === "execute" ||
                current.phase === "verify");
            const goal = isTruthy(current.goal)
              ? {
                  ...current.goal,
                  evidence: [...current.goal.evidence, ...input.goalEvidence],
                  verification: recordGoalVerification ? verification : current.goal.verification,
                  updatedAt: now,
                  ...optionalProperty("completion", snapshot),
                  ...optionalProperty("completionRequest", completionRequest),
                }
              : null;
            const plan = isTruthy(current.plan)
              ? {
                  ...current.plan,
                  steps,
                  evidence: [...current.plan.evidence, ...input.planEvidence],
                  verification: recordPlanVerification ? verification : current.plan.verification,
                  updatedAt: now,
                }
              : null;
            const kind =
              input.goalStatus === "paused"
                ? "goal_paused"
                : input.goalStatus === "active" && current.goal?.status === "paused"
                  ? "goal_resumed"
                  : input.goalStatus === "failed"
                    ? "workflow_stopped"
                    : verification === null
                      ? "progress_updated"
                      : verification.status === "invalid_hypothesis" ||
                          verification.status === "invalid_criterion"
                        ? "verification_invalidated"
                        : "verification_recorded";
            const next = withStanding({ ...current, goal, plan }, outcome.standing, now);
            const recordedNext: WorkflowState = {
              ...next,
              ledger: [...next.ledger, event(current, kind, input.detail, now)],
            };
            // Completing the Goal and its Plan together ends the progress position too.
            return yield* save(
              sessionId,
              next.phase === current.phase
                ? recordedNext
                : {
                    ...recordedNext,
                    ledger: [
                      ...recordedNext.ledger,
                      event(
                        recordedNext,
                        "phase_changed",
                        `${current.phase} -> ${next.phase} (goal completed)`,
                        now,
                      ),
                    ],
                  },
              author,
            );
          }),
        ),

      /**
       * Ends the Plan without completing it, with the author's reason. Refused when there is no
       * Plan or it already ended.
       */
      closePlan: (sessionId: string, reason: string, author?: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const outcome = goalTransitions.PlanClosed(goalState(current), GoalEvent.PlanClosed());
            if (outcome._tag === "Refused")
              return yield* BoardEditRefused.make({ reason: outcome.reason });
            // The transition refused a missing Plan; this narrows its type.
            if (current.plan === null)
              return yield* BoardEditRefused.make({ reason: "plan_missing" });
            const detail = `plan v${current.plan.version} closed: ${reason}`;
            return yield* save(
              sessionId,
              closing(
                current,
                closedPlan(current.plan),
                detail,
                yield* nowIso,
                outcome.standing.phase,
              ),
              author,
            );
          }),
        ),

      /**
       * Saves a board change with its author. A user's change to an executing card is stored as a
       * pending request for the orchestrator and leaves the card as it is.
       */
      editBoard: (sessionId: string, edit: BoardEdit, author: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const cardId = `card-${(yield* crypto.randomUUIDv4()).slice(0, 8)}`;
            const planned = yield* planBoardEdit(current.plan, edit, author, cardId);
            const now = yield* nowIso;
            return yield* Match.valueTags(planned, {
              Apply: Effect.fnUntraced(function* (change) {
                const next = yield* boardChanged(current, change, now);
                return BoardEditResult.Applied({ state: yield* save(sessionId, next, author) });
              }),
              Request: Effect.fnUntraced(function* ({ cardId, change }) {
                const changeJson = yield* encodeChange(change);
                const inserted = yield* sql<{
                  readonly id: number;
                }>`INSERT INTO board_change_requests
                (session_id, goal_instance_id, card_id, plan_version, change_json, status, created_at)
                VALUES (${sessionId},
                  (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}),
                  ${cardId}, ${edit.planVersion}, ${changeJson}, 'pending', ${now})
                RETURNING id`;
                const request: UserChangeRequest = {
                  id: Number(inserted[0]?.id),
                  cardId,
                  planVersion: edit.planVersion,
                  change,
                  status: "pending",
                  reason: null,
                  createdAt: now,
                };
                return BoardEditResult.Requested({ request });
              }),
              Close: Effect.fnUntraced(function* ({ plan, detail }) {
                const standing = yield* boardEdited(current, plan, true);
                const next = closing(current, plan, detail, now, standing.phase);
                return BoardEditResult.Applied({ state: yield* save(sessionId, next, author) });
              }),
            });
          }),
        ),

      /** Puts a card not started yet on hold, or releases it; recorded with its author. */
      holdCard: (
        sessionId: string,
        change: { readonly cardId: string; readonly hold: boolean },
        author: BoardAuthor,
      ) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const now = yield* nowIso;
            const planned = yield* planCardHold(current.plan, change, author, now);
            return yield* save(sessionId, yield* boardChanged(current, planned, now), author);
          }),
        ),

      /**
       * Moves a card's status with its author. Refused when the card is no longer in `from`, so
       * two authors racing for the same card cannot both win.
       */
      transitionCard: (sessionId: string, transition: CardTransition, author: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const planned = yield* planCardTransition(current.plan, transition);
            const now = yield* nowIso;
            return yield* save(sessionId, yield* boardChanged(current, planned, now), author);
          }),
        ),
    };
  });

/** Versioned Goal/Plan artifacts and their execution ledger, scoped to a session. */
export class Workflows extends Context.Service<
  Workflows,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/workflow/workflow/Workflows") {
  static readonly layer = Layer.effect(Workflows, make()).pipe(Layer.provide(NodeCrypto.layer));
  /** Compatible code rollback disables only the new action; never deletes history or lowers schema. */
  static readonly layerWithOptions = (options: { readonly allowNewGoal: boolean }) =>
    Layer.effect(Workflows, make(options)).pipe(Layer.provide(NodeCrypto.layer));
}
