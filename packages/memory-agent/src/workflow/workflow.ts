import { isTruthy } from "../truthy.ts";
import { NodeCrypto } from "@effect/platform-node";
import {
  DateTime,
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { evaluateWorkflowAction, type WorkflowActionReason } from "./actions.ts";
import {
  completionEvidence,
  CompletionRequest,
  CompletionSnapshot,
  CriterionMapping,
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
  planBoardEdit,
  planCardHold,
  planCardTransition,
  UserChange,
  type BoardEdit,
  type CardTransition,
  type UserChangeRequest,
} from "./board-edit.ts";
import { acknowledgedRunSql, resolvedRunSql } from "./run-bindings.ts";

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

const verificationDefault = (): Verification => ({
  status: "not_run",
  summary: "",
  evidence: [],
  recoveryPhase: null,
  updatedAt: null,
});

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
  evidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
  ),
  verification: Verification.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(verificationDefault)),
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
  Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
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
  return steps.map((step) => {
    switch (step.status) {
      case "pending":
        return { ...step, status: notStarted(step) };
      case "completed":
        return { ...step, status: "done" as const };
      case "backlog":
      case "ready":
      case "in_progress":
      case "verify":
      case "human_decision":
      case "done":
      case "blocked":
        return { ...step, status: step.status };
    }
  });
};

const planFields = {
  version: Schema.Int,
  goalVersion: Schema.Int,
  summary: Schema.String,
  steps: Schema.Array(PlanStep),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
  ),
  verification: Verification.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(verificationDefault)),
  ),
  updatedAt: Schema.String,
} as const;

export const PlanArtifact = Schema.Struct({
  ...planFields,
  status: Schema.Literals(["draft", "ready", "executing", "completed", "blocked"]),
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

export class NewGoalTransitionRefused extends Data.TaggedError("NewGoalTransitionRefused")<{
  readonly reason:
    | "disabled"
    | "phase_not_authorized"
    | "goal_missing"
    | "workflow_changed"
    | "run_outcome_uncertain"
    | "transition_pending"
    | "owner_effect_uncertain"
    | "execution_outstanding";
}> {}

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
  evidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
  ),
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
  steps: Schema.Array(StepProgress).pipe(Schema.withDecodingDefaultTypeKey(Effect.sync(() => []))),
  goalEvidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
  ),
  planEvidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
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
  status: Schema.Literals(["draft", "ready", "approved", "executing", "completed", "blocked"]),
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
export class WorkflowStorageError extends Schema.TaggedError<WorkflowStorageError>()(
  "WorkflowStorageError",
  { cause: Schema.Defect() },
) {}
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

export class WorkflowTransitionRefused extends Data.TaggedError("WorkflowTransitionRefused")<{
  readonly reason: WorkflowActionReason;
}> {}

export class WorkflowProgressRefused extends Data.TaggedError("WorkflowProgressRefused")<{
  readonly reason:
    | WorkflowActionReason
    | "plan_missing"
    | "unknown_step"
    | "step_evidence_required"
    | "verification_required"
    | "steps_incomplete"
    | "phase_not_executable"
    | "completion_evidence_required"
    | "completion_evidence_invalid"
    | "completion_snapshot_conflict";
}> {}

const implementationComplete = (plan: PlanArtifact) =>
  plan.steps.every((step) => step.status === "done" && step.evidence.length > 0);

/** Source-state authorization is distinct from the run/owner-effect quiescence checks. */
function newGoalTransitionSource(
  state: WorkflowState,
):
  | { allowed: true; closedVerification: boolean }
  | { allowed: false; reason: "phase_not_authorized" | "goal_missing" } {
  const closedVerification =
    state.goal?.status === "completed" && state.goal.verification.status === "passed";
  // Goal/Plan accept an explicitly independent task; execution and chat never do.
  if (state.phase === "goal" || state.phase === "plan")
    return state.goal === null
      ? { allowed: false, reason: "goal_missing" }
      : { allowed: true, closedVerification: false };
  // Verify remains open unless its Goal's verification is complete. A completed
  // phase must also have a completed Plan, not merely a mismatched persisted phase.
  if (
    closedVerification &&
    (state.phase === "verify" ||
      (state.phase === "completed" &&
        state.plan?.status === "completed" &&
        state.plan.verification.status === "passed"))
  )
    return { allowed: true, closedVerification: true };
  return { allowed: false, reason: "phase_not_authorized" };
}

/** Derives the only phase that can make progress from the durable artifacts. */
export function reconciledWorkflowPhase(state: WorkflowState): WorkflowPhase {
  if (state.phase !== "execute" && state.phase !== "verify") return state.phase;
  if (state.plan === null || state.goal === null) return state.goal === null ? "goal" : "plan";
  if (state.plan.goalVersion !== state.goal.version) return "plan";
  if (state.plan.status !== "executing")
    return state.plan.status === "completed" || state.plan.status === "blocked"
      ? state.phase
      : "plan";

  const complete = implementationComplete(state.plan);
  if (state.plan.verification.status === "failed" && state.plan.verification.evidence.length > 0)
    return "execute";
  if (state.phase === "execute") return complete ? "verify" : "execute";
  if (!complete) return "execute";

  const verification = state.plan.verification;
  if (verification.evidence.length === 0) return "verify";
  switch (verification.status) {
    case "failed":
      return "execute";
    case "invalid_hypothesis":
      return verification.recoveryPhase ?? "plan";
    case "invalid_criterion":
    case "inconclusive":
      return "plan";
    case "not_run":
    case "passed":
    case "blocked":
      return "verify";
  }
}

const make = (options: { readonly allowNewGoal?: boolean } = {}) =>
  Effect.gen(function* () {
    const effectClock = yield* Clock.Clock;
    const crypto = yield* Crypto.Crypto;
    const sql = yield* SqlClient.SqlClient;
    const completion = yield* completionEvidence;
    const serialize = yield* keyedSerialLimit();
    const nowIso = () =>
      DateTime.formatIso(DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()));
    /** One session's read-modify-write runs alone and commits or rolls back as a whole. */
    const locked = <A, E>(sessionId: string, effect: Effect.Effect<A, E>) =>
      serialize(sessionId, persisted(sql.withTransaction(effect)));
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
        reason: Schema.NullOr(Schema.String),
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
      const now = nowIso();
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
      locked(
        sessionId,
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
    ) => ({
      sequence: (state.ledger.at(-1)?.sequence ?? 0) + 1,
      at: nowIso(),
      kind,
      detail,
    });

    const refuseNewGoal = (reason: NewGoalTransitionRefused["reason"]) =>
      Effect.fail(new NewGoalTransitionRefused({ reason }));
    // Used both at tool admission and again at the completed-run owner boundary.
    // Only admission may exclude its own (still running) run; application excludes none.
    const checkNewGoal = Effect.fnUntraced(function* (
      sessionId: string,
      input: StartNewGoal,
      callingRunId?: string,
    ) {
      if (options.allowNewGoal === false) return yield* refuseNewGoal("disabled");
      const current = yield* get(sessionId);
      const source = newGoalTransitionSource(current);
      if (!source.allowed) return yield* refuseNewGoal(source.reason);
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
      return { current, identity, closedVerification: source.closedVerification };
    });
    const commitNewGoal = Effect.fnUntraced(function* (sessionId: string, input: StartNewGoal) {
      const { current, identity, closedVerification } = yield* checkNewGoal(sessionId, input);
      const now = nowIso();
      const newId = yield* crypto.randomUUIDv4();
      if (Option.isSome(identity)) {
        yield* sql`INSERT INTO workflow_goal_instances VALUES (${newId}, ${sessionId}, ${now})`;
        yield* sql`UPDATE workflow_goal_identities SET goal_instance_id = ${newId}, created_at = ${now}
          WHERE session_id = ${sessionId}`;
      } else {
        // An unbound legacy Goal never receives a fabricated historical identity.
        yield* insertGoalIdentity(sessionId, newId, now);
      }
      const state = yield* save(sessionId, {
        phase: closedVerification ? "goal" : current.phase,
        goal: {
          ...input.goal,
          version: 1,
          evidence: [],
          verification: verificationDefault(),
          updatedAt: now,
        },
        plan: null,
        ledger: [
          ...current.ledger,
          event(
            current,
            "goal_updated",
            `explicit new Goal ${newId}; prior ${input.previousGoalInstanceId ?? "legacy/unbound"}; ${input.reason}`,
          ),
        ],
      });
      return { state, newId };
    });

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
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const phase = reconciledWorkflowPhase(current);
            if (phase === current.phase) return current;
            const next = { ...current, phase };
            return yield* save(sessionId, {
              ...next,
              ledger: [
                ...next.ledger,
                event(current, "phase_changed", `${current.phase} -> ${phase} (state reconciled)`),
              ],
            });
          }),
        ),

      setPhase: (sessionId: string, phase: WorkflowPhase) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const decision = evaluateWorkflowAction(current, { kind: "phase", phase });
            if (!decision.allowed)
              return yield* new WorkflowTransitionRefused({ reason: decision.reason });
            const now = nowIso();
            const goal =
              phase === "execute" && current.goal?.status === "draft"
                ? { ...current.goal, status: "active" as const, updatedAt: now }
                : current.goal;
            const plan =
              phase === "execute" && current.plan?.status === "ready"
                ? { ...current.plan, status: "executing" as const, updatedAt: now }
                : current.plan;
            const next = { ...current, phase, goal, plan };
            return yield* save(sessionId, {
              ...next,
              ledger: [
                ...next.ledger,
                event(current, "phase_changed", `${current.phase} -> ${phase}`),
              ],
            });
          }),
        ),

      controlGoal: (sessionId: string, action: WorkflowAction) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const decision = evaluateWorkflowAction(current, { kind: "control", action });
            if (!decision.allowed)
              return yield* new WorkflowProgressRefused({ reason: decision.reason });
            // An allowed control always has a goal; keep narrowing local to the mutation.
            if (current.goal === null)
              return yield* new WorkflowProgressRefused({ reason: "goal_missing" });
            const currentGoal = current.goal;
            const now = nowIso();
            const goalStatus =
              action === "pause" ? "paused" : action === "resume" ? "active" : "failed";
            const plan =
              action === "stop" && current.plan?.status === "executing"
                ? { ...current.plan, status: "blocked" as const, updatedAt: now }
                : current.plan;
            const phase =
              action === "resume"
                ? plan?.status === "executing"
                  ? "execute"
                  : "goal"
                : current.phase;
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
            const next: WorkflowState = {
              ...current,
              phase,
              goal: { ...currentGoal, status: goalStatus, updatedAt: now },
              plan,
            };
            return yield* save(sessionId, {
              ...next,
              ledger: [...next.ledger, event(current, kind, detail)],
            });
          }),
        ),

      finishRun: (sessionId: string, startedPhase: WorkflowPhase) =>
        change(sessionId, (current) =>
          Effect.gen(function* () {
            const now = nowIso();
            if (startedPhase === "execute" && current.phase === "execute") {
              const readyToVerify =
                current.plan !== null &&
                current.plan.status === "executing" &&
                current.plan.verification.status !== "failed" &&
                implementationComplete(current.plan);
              if (!readyToVerify) return current;
              const next = { ...current, phase: "verify" as const };
              return {
                ...next,
                ledger: [...next.ledger, event(current, "phase_changed", "execute -> verify")],
              };
            }
            if (
              startedPhase !== "verify" ||
              current.phase !== "verify" ||
              current.plan === null ||
              current.plan.status === "completed"
            )
              return current;
            const verification = current.plan.verification;
            if (verification.status === "not_run" || verification.evidence.length === 0)
              return current;
            if (verification.status !== "passed") {
              const phase =
                verification.status === "failed"
                  ? ("execute" as const)
                  : verification.status === "invalid_hypothesis"
                    ? (verification.recoveryPhase ?? "plan")
                    : verification.status === "blocked"
                      ? ("verify" as const)
                      : ("plan" as const);
              const plan =
                verification.status === "blocked"
                  ? { ...current.plan, status: "blocked" as const, updatedAt: now }
                  : current.plan;
              if (phase === current.phase && plan === current.plan) return current;
              return {
                ...current,
                phase,
                plan,
                ledger:
                  phase === current.phase
                    ? current.ledger
                    : [
                        ...current.ledger,
                        event(
                          current,
                          "phase_changed",
                          `verify -> ${phase} (${verification.status})`,
                        ),
                      ],
              };
            }
            const verified = current.plan.steps.every((step) => step.status === "done");
            if (!verified) return current;
            const request = current.goal?.completionRequest;
            let snapshot = current.goal?.completion;
            if (
              request !== undefined &&
              current.goal !== null &&
              request.goalVersion === current.goal.version &&
              request.planVersion === current.plan.version
            ) {
              const derived = yield* completion.derive(
                sessionId,
                current,
                request.mappings,
                request.recorderRunId,
              );
              if (derived.status === "accepted") snapshot = derived.snapshot;
            }
            // Native registration authorizes execution, not successful criterion coverage.
            // Legacy/unprovenanced Goals retain the release-compatible automatic completion.
            if (
              (yield* completion.required(sessionId)) &&
              (!isTruthy(snapshot) ||
                snapshot.goalVersion !== current.goal?.version ||
                snapshot.planVersion !== current.plan.version)
            )
              return current;
            const goal = isTruthy(current.goal)
              ? {
                  ...current.goal,
                  status: "completed" as const,
                  verification: current.plan.verification,
                  updatedAt: now,
                }
              : null;
            if (goal !== null && snapshot !== undefined) goal.completion = snapshot;
            const plan = { ...current.plan, status: "completed" as const, updatedAt: now };
            return {
              ...current,
              phase: "completed" as const,
              goal,
              plan,
              ledger: [
                ...current.ledger,
                event(current, "progress_updated", "Verification completed the workflow"),
              ],
            };
          }),
        ),

      /** Direct owner transition requires a fully quiescent session. */
      startNewGoal: (sessionId: string, input: StartNewGoal) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            if (yield* pendingNewGoal(sessionId)) return yield* refuseNewGoal("transition_pending");
            return (yield* commitNewGoal(sessionId, input)).state;
          }),
        ),

      /** Tool admission only records a durable request; never claims a new Goal was saved. */
      requestNewGoal: (sessionId: string, runId: string, input: StartNewGoal) =>
        locked(
          sessionId,
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
            yield* checkNewGoal(sessionId, input, runId);
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
                ${payload}, 'accepted', ${nowIso()})`;
            return { status: "accepted" as const, runId };
          }),
        ),

      /** Idempotent owner settlement. A failed or missing run can never apply its intent. */
      settleNewGoalRequest: (sessionId: string, runId: string) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            const found = yield* settlementOf(runId);
            if (Option.isNone(found) || found.value.session_id !== sessionId)
              return { status: "none" as const };
            const row = found.value;
            if (row.status === "applied")
              return { status: "applied" as const, goalInstanceId: row.applied_goal_instance_id };
            if (row.status === "rejected")
              return { status: "rejected" as const, reason: row.reason };
            const run = Option.getOrUndefined(yield* runOf(runId));
            if (
              run?.thread_id === sessionId &&
              (run.status === "running" || run.status === "interrupted")
            )
              return { status: "accepted" as const };
            const reject = (reason: string) =>
              sql`UPDATE workflow_new_goal_requests SET status = 'rejected', reason = ${reason},
                settled_at = ${nowIso()} WHERE run_id = ${runId} AND status = 'accepted'`.pipe(
                Effect.as({ status: "rejected" as const, reason }),
              );
            if (run?.thread_id !== sessionId || run.status !== "completed")
              return yield* reject("run_outcome_uncertain");
            const latest = yield* latestRevision(sessionId);
            if (Option.getOrUndefined(latest)?.id !== row.source_revision_id)
              return yield* reject("workflow_changed");
            const input = yield* decodeRequest(row.payload_json);
            return yield* commitNewGoal(sessionId, input).pipe(
              Effect.flatMap(({ newId }) =>
                sql`UPDATE workflow_new_goal_requests
                  SET status = 'applied', applied_goal_instance_id = ${newId}, settled_at = ${nowIso()}
                  WHERE run_id = ${runId} AND status = 'accepted'`.pipe(
                  Effect.as({ status: "applied" as const, goalInstanceId: newId }),
                ),
              ),
              Effect.catchTag("NewGoalTransitionRefused", (error) => reject(error.reason)),
            );
          }),
        ),

      updateGoal: (sessionId: string, input: UpdateGoal) =>
        change(sessionId, (current) =>
          Effect.gen(function* () {
            // Only the first Goal in a new session is unambiguously new. A legacy Goal
            // without a recorded identity stays unbound; guessing it from text is unsafe.
            if (current.goal === null)
              yield* insertGoalIdentity(sessionId, yield* crypto.randomUUIDv4(), nowIso());
            const goal: GoalArtifact = {
              ...input,
              evidence: [],
              verification: verificationDefault(),
              version: (current.goal?.version ?? 0) + 1,
              updatedAt: DateTime.formatIso(
                DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
              ),
            };
            // A kanban board keeps executing: its orchestrator classifies each card against the new
            // Goal instead (docs/kanban-orchestration.md "식별자와 Goal 변경").
            const phase =
              (current.phase === "execute" || current.phase === "verify") &&
              !(yield* kanbanBoard(sessionId))
                ? "plan"
                : current.phase;
            const revised = {
              ...current,
              phase,
              goal,
              ledger: [
                ...current.ledger,
                event(current, "goal_updated", `goal v${goal.version} (${goal.status})`),
              ],
            };
            return phase === current.phase
              ? revised
              : {
                  ...revised,
                  ledger: [
                    ...revised.ledger,
                    event(revised, "phase_changed", `${current.phase} -> plan (goal revised)`),
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
                Effect.sync(() => {
                  const previous = new Map(
                    current.plan?.steps.map((step) => [step.id, step]) ?? [],
                  );
                  const plan: PlanArtifact = {
                    ...input,
                    steps: cardStatuses(
                      input.steps.map((step) => {
                        const replanned = { ...step, status: "pending" as const, evidence: [] };
                        const prior = previous.get(step.id);
                        if (prior === undefined) return replanned;
                        const held = prior.hold === undefined ? {} : { hold: prior.hold };
                        return { ...cardContract(prior), ...held, ...replanned };
                      }),
                    ),
                    evidence: [],
                    verification: verificationDefault(),
                    version: (current.plan?.version ?? 0) + 1,
                    goalVersion: current.goal?.version ?? 0,
                    updatedAt: nowIso(),
                  };
                  const kind = current.plan === null ? "plan_updated" : "plan_replanned";
                  const phase =
                    current.phase === "execute" || current.phase === "verify"
                      ? "plan"
                      : current.phase;
                  const planned = {
                    ...current,
                    phase,
                    plan,
                    ledger: [
                      ...current.ledger,
                      event(current, kind, `plan v${plan.version} (${plan.status})`),
                    ],
                  };
                  return phase === current.phase
                    ? planned
                    : {
                        ...planned,
                        ledger: [
                          ...planned.ledger,
                          event(
                            planned,
                            "phase_changed",
                            `${current.phase} -> plan (plan revised)`,
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
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            if (input.goalStatus !== undefined && current.goal === null)
              return yield* new WorkflowProgressRefused({ reason: "goal_missing" });
            if ((input.planStatus !== undefined || input.steps.length > 0) && current.plan === null)
              return yield* new WorkflowProgressRefused({ reason: "plan_missing" });
            if (
              input.steps.some(
                (update) => !isTruthy(current.plan?.steps.some((step) => step.id === update.id)),
              )
            )
              return yield* new WorkflowProgressRefused({ reason: "unknown_step" });
            if (
              current.phase === "plan" &&
              (input.planStatus !== undefined ||
                input.steps.length > 0 ||
                input.planEvidence.length > 0 ||
                input.verification !== undefined)
            )
              return yield* new WorkflowProgressRefused({ reason: "phase_not_executable" });

            // Progress names a step in the model's vocabulary; an untouched card keeps its column.
            const steps = cardStatuses(
              current.plan?.steps.map((step) => {
                const update = input.steps.find((candidate) => candidate.id === step.id);
                if (!isTruthy(update)) return step;
                return {
                  ...step,
                  status: update.status,
                  evidence: [...step.evidence, ...update.evidence],
                };
              }) ?? [],
            );
            if (steps.some((step) => step.status === "done" && step.evidence.length === 0))
              return yield* new WorkflowProgressRefused({ reason: "step_evidence_required" });

            const verification = isTruthy(input.verification)
              ? {
                  ...input.verification,
                  recoveryPhase: input.verification.recoveryPhase ?? null,
                  updatedAt: nowIso(),
                }
              : null;
            const goalVerification = verification ?? current.goal?.verification;
            if (
              input.goalStatus === "completed" &&
              (goalVerification?.status !== "passed" || goalVerification.evidence.length === 0)
            )
              return yield* new WorkflowProgressRefused({ reason: "verification_required" });
            const planVerification = verification ?? current.plan?.verification;
            if (
              input.planStatus === "completed" &&
              (planVerification?.status !== "passed" || planVerification.evidence.length === 0)
            )
              return yield* new WorkflowProgressRefused({ reason: "verification_required" });
            if (input.planStatus === "completed" && steps.some((step) => step.status !== "done"))
              return yield* new WorkflowProgressRefused({ reason: "steps_incomplete" });

            let snapshot = current.goal?.completion;
            let completionRequest = current.goal?.completionRequest;
            const stageCompletion =
              (yield* completion.required(sessionId)) && (yield* completion.running(recorderRunId));
            if (input.criterionMappings !== undefined) {
              const derived = yield* completion.derive(
                sessionId,
                {
                  ...current,
                  plan: isTruthy(current.plan) ? { ...current.plan, steps } : null,
                },
                input.criterionMappings,
                recorderRunId,
                stageCompletion,
              );
              if (derived.status === "refused")
                return yield* new WorkflowProgressRefused({
                  reason: "completion_evidence_invalid",
                });
              if (isTruthy(snapshot) && !sameSnapshot(snapshot, derived.snapshot))
                return yield* new WorkflowProgressRefused({
                  reason: "completion_snapshot_conflict",
                });
              if (goalVerification?.status !== "passed" || goalVerification.evidence.length === 0)
                return yield* new WorkflowProgressRefused({ reason: "verification_required" });
              if (stageCompletion) {
                completionRequest = {
                  recorderRunId,
                  goalVersion: derived.snapshot.goalVersion,
                  planVersion: derived.snapshot.planVersion,
                  mappings: input.criterionMappings,
                };
              } else snapshot = derived.snapshot;
            }
            if (
              input.goalStatus === "completed" &&
              (yield* completion.required(sessionId)) &&
              !stageCompletion
            ) {
              if (!isTruthy(snapshot))
                return yield* new WorkflowProgressRefused({
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
              if (checked.status === "refused" || !sameSnapshot(checked.snapshot, snapshot))
                return yield* new WorkflowProgressRefused({
                  reason: "completion_evidence_invalid",
                });
            }
            const now = nowIso();
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
                  status:
                    stageCompletion && input.goalStatus === "completed"
                      ? current.goal.status
                      : (input.goalStatus ?? current.goal.status),
                  evidence: [...current.goal.evidence, ...input.goalEvidence],
                  verification: recordGoalVerification ? verification : current.goal.verification,
                  updatedAt: now,
                }
              : null;
            if (isTruthy(goal) && isTruthy(snapshot)) goal.completion = snapshot;
            if (isTruthy(goal) && completionRequest !== undefined)
              goal.completionRequest = completionRequest;
            const plan = isTruthy(current.plan)
              ? {
                  ...current.plan,
                  status:
                    stageCompletion && input.planStatus === "completed"
                      ? current.plan.status
                      : (input.planStatus ?? current.plan.status),
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
            const next: WorkflowState = { ...current, goal, plan };
            return yield* save(
              sessionId,
              { ...next, ledger: [...next.ledger, event(current, kind, input.detail)] },
              author,
            );
          }),
        ),

      /**
       * Saves a board change with its author. A user's change to an executing card is stored as a
       * pending request for the orchestrator and leaves the card as it is.
       */
      editBoard: (sessionId: string, edit: BoardEdit, author: BoardAuthor) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const cardId = `card-${(yield* crypto.randomUUIDv4()).slice(0, 8)}`;
            const planned = yield* planBoardEdit(current.plan, edit, author, cardId);
            const now = nowIso();
            switch (planned._tag) {
              case "Apply": {
                const next: WorkflowState = {
                  ...current,
                  plan: { ...planned.plan, updatedAt: now },
                  ledger: [...current.ledger, event(current, "board_updated", planned.detail)],
                };
                return { _tag: "Applied" as const, state: yield* save(sessionId, next, author) };
              }
              case "Request": {
                const changeJson = yield* encodeChange(planned.change);
                const inserted = yield* sql<{
                  readonly id: number;
                }>`INSERT INTO board_change_requests
                  (session_id, goal_instance_id, card_id, plan_version, change_json, status, created_at)
                  VALUES (${sessionId},
                    (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}),
                    ${planned.cardId}, ${edit.planVersion}, ${changeJson}, 'pending', ${now})
                  RETURNING id`;
                const request: UserChangeRequest = {
                  id: Number(inserted[0]?.id),
                  cardId: planned.cardId,
                  planVersion: edit.planVersion,
                  change: planned.change,
                  status: "pending",
                  reason: null,
                  createdAt: now,
                };
                return { _tag: "Requested" as const, request };
              }
            }
          }),
        ),

      /** Puts a card not started yet on hold, or releases it; recorded with its author. */
      holdCard: (
        sessionId: string,
        change: { readonly cardId: string; readonly hold: boolean },
        author: BoardAuthor,
      ) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const now = nowIso();
            const planned = yield* planCardHold(current.plan, change, author, now);
            const next: WorkflowState = {
              ...current,
              plan: { ...planned.plan, updatedAt: now },
              ledger: [...current.ledger, event(current, "board_updated", planned.detail)],
            };
            return yield* save(sessionId, next, author);
          }),
        ),

      /**
       * Moves a card's status with its author. Refused when the card is no longer in `from`, so
       * two authors racing for the same card cannot both win.
       */
      transitionCard: (sessionId: string, transition: CardTransition, author: BoardAuthor) =>
        locked(
          sessionId,
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const planned = yield* planCardTransition(current.plan, transition);
            const next: WorkflowState = {
              ...current,
              plan: { ...planned.plan, updatedAt: nowIso() },
              ledger: [...current.ledger, event(current, "board_updated", planned.detail)],
            };
            return yield* save(sessionId, next, author);
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
