import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { Database } from "../db/database.ts";
import { evaluateWorkflowAction, type WorkflowActionReason } from "./actions.ts";
import { completionEvidence, CompletionSnapshot, CriterionMapping } from "./completion-evidence.ts";

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

export const PlanStep = Schema.Struct({
  ...planStepFields,
  status: Schema.Literals(["pending", "in_progress", "completed", "blocked"]),
  evidence: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
  ),
});
export type PlanStep = typeof PlanStep.Type;

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
  status: Schema.Literals(["pending", "in_progress", "completed", "blocked"]),
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
  status: Schema.Literals(["draft", "ready", "approved", "executing", "completed", "blocked"]),
});
const PersistedWorkflowState = Schema.Struct({
  phase: WorkflowPhase,
  goal: Schema.NullOr(PersistedGoalArtifact),
  plan: Schema.NullOr(PersistedPlanArtifact),
  ledger: Schema.Array(LedgerEvent),
});
const decodePersistedState = Schema.decodeUnknownSync(
  Schema.fromJsonString(PersistedWorkflowState),
);
const decodeState = (json: string): WorkflowState => {
  const state = decodePersistedState(json);
  return {
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
            status: state.plan.status === "approved" ? "executing" : state.plan.status,
          },
  };
};
const encodeState = Schema.encodeSync(Schema.fromJsonString(WorkflowState));
const decodeRow = Schema.decodeUnknownSync(Schema.Struct({ state_json: Schema.String }));

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

function rowText(row: Record<string, SQLOutputValue> | undefined) {
  return row ? decodeRow(row).state_json : null;
}

const implementationComplete = (plan: PlanArtifact) =>
  plan.steps.every((step) => step.status === "completed" && step.evidence.length > 0);

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
    const { sqlite, atomic } = yield* Database;
    const completion = completionEvidence(sqlite);
    const serialize = keyedSerialLimit();
    const select = sqlite.prepare("SELECT state_json FROM session_workflows WHERE session_id = ?");
    const upsert = sqlite.prepare(`
    INSERT INTO session_workflows (session_id, state_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `);
    const insertGoalIdentity = sqlite.prepare(`
    INSERT INTO workflow_goal_identities (session_id, goal_instance_id, created_at)
    VALUES (?, ?, ?)
  `);
    const recordRevision = sqlite.prepare(`
    INSERT INTO workflow_state_revisions
      (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
    VALUES (?, ?, ?, ?, 'recorded', ?,
      (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?))
  `);

    const get = (sessionId: string): WorkflowState => {
      const json = rowText(select.get(sessionId));
      return json === null ? emptyState() : decodeState(json);
    };
    const save = (sessionId: string, state: WorkflowState) => {
      const now = new Date().toISOString();
      const json = encodeState(state);
      upsert.run(sessionId, json, now);
      recordRevision.run(
        sessionId,
        json,
        state.goal?.version ?? null,
        state.plan?.version ?? null,
        now,
        sessionId,
      );
      return state;
    };
    const change = (sessionId: string, update: (current: WorkflowState) => WorkflowState) =>
      serialize(
        sessionId,
        Effect.sync(() =>
          atomic(() => {
            const current = get(sessionId);
            const next = update(current);
            return next === current ? current : save(sessionId, next);
          }),
        ),
      );
    const event = (
      state: WorkflowState,
      kind: (typeof LedgerEvent.Type)["kind"],
      detail: string,
    ) => ({
      sequence: (state.ledger.at(-1)?.sequence ?? 0) + 1,
      at: new Date().toISOString(),
      kind,
      detail,
    });

    const refuseNewGoal = (reason: NewGoalTransitionRefused["reason"]): never => {
      throw new NewGoalTransitionRefused({ reason });
    };
    // Used both at tool admission and again at the completed-run owner boundary.
    // Only admission may exclude its own (still running) run; application excludes none.
    const checkNewGoal = (sessionId: string, input: StartNewGoal, callingRunId?: string) => {
      if (options.allowNewGoal === false) refuseNewGoal("disabled");
      const current = get(sessionId);
      const source = newGoalTransitionSource(current);
      if (!source.allowed) return refuseNewGoal(source.reason);
      const identity = sqlite
        .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
        .get(sessionId);
      if ((identity?.goal_instance_id ?? null) !== input.previousGoalInstanceId)
        refuseNewGoal("workflow_changed");
      if (
        sqlite
          .prepare(`
          SELECT b.run_id FROM workflow_run_bindings b LEFT JOIN chat_runs r ON r.run_id = b.run_id
          WHERE b.session_id = ? AND b.run_id <> ? AND (r.status IS NULL OR r.status <> 'completed') LIMIT 1
        `)
          .get(sessionId, callingRunId ?? "") ||
        sqlite
          .prepare(`
          SELECT run_id FROM chat_runs WHERE thread_id = ? AND run_id <> ? AND status <> 'completed' LIMIT 1
        `)
          .get(sessionId, callingRunId ?? "")
      )
        refuseNewGoal("run_outcome_uncertain");
      if (
        sqlite
          .prepare(`
        SELECT o.run_id FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id = o.run_id
        WHERE b.session_id = ? AND (o.status = 'pending' OR (o.side_effect = 1 AND o.status = 'uncertain')) LIMIT 1
      `)
          .get(sessionId)
      )
        refuseNewGoal("owner_effect_uncertain");
      if (
        sqlite
          .prepare(`
        SELECT id FROM work_tasks WHERE origin_session_id = ? AND status NOT IN ('completed', 'archived') LIMIT 1
      `)
          .get(sessionId)
      )
        refuseNewGoal("execution_outstanding");
      return { current, identity, closedVerification: source.closedVerification };
    };
    const commitNewGoal = (sessionId: string, input: StartNewGoal) => {
      const { current, identity, closedVerification } = checkNewGoal(sessionId, input);
      const now = new Date().toISOString();
      const newId = randomUUID();
      if (identity) {
        sqlite
          .prepare("INSERT INTO workflow_goal_instances VALUES (?, ?, ?)")
          .run(newId, sessionId, now);
        sqlite
          .prepare(
            "UPDATE workflow_goal_identities SET goal_instance_id = ?, created_at = ? WHERE session_id = ?",
          )
          .run(newId, now, sessionId);
      } else {
        // An unbound legacy Goal never receives a fabricated historical identity.
        insertGoalIdentity.run(sessionId, newId, now);
      }
      const state = save(sessionId, {
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
    };

    return {
      get: (sessionId: string) => Effect.sync(() => get(sessionId)),
      goalInstanceId: (sessionId: string) =>
        Effect.sync(() => {
          const row = sqlite
            .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
            .get(sessionId);
          return row ? String(row.goal_instance_id) : null;
        }),

      /** Repairs stale persisted phases before a new turn or an idle status response. */
      reconcile: (sessionId: string) =>
        serialize(
          sessionId,
          Effect.sync(() => {
            const current = get(sessionId);
            const phase = reconciledWorkflowPhase(current);
            if (phase === current.phase) return current;
            const next = { ...current, phase };
            return atomic(() =>
              save(sessionId, {
                ...next,
                ledger: [
                  ...next.ledger,
                  event(
                    current,
                    "phase_changed",
                    `${current.phase} -> ${phase} (state reconciled)`,
                  ),
                ],
              }),
            );
          }),
        ),

      setPhase: (sessionId: string, phase: WorkflowPhase) =>
        serialize(
          sessionId,
          Effect.suspend(() => {
            const current = get(sessionId);
            const decision = evaluateWorkflowAction(current, { kind: "phase", phase });
            if (!decision.allowed)
              return Effect.fail(new WorkflowTransitionRefused({ reason: decision.reason }));
            return Effect.sync(() =>
              atomic(() => {
                const now = new Date().toISOString();
                const goal =
                  phase === "execute" && current.goal?.status === "draft"
                    ? { ...current.goal, status: "active" as const, updatedAt: now }
                    : current.goal;
                const plan =
                  phase === "execute" && current.plan?.status === "ready"
                    ? { ...current.plan, status: "executing" as const, updatedAt: now }
                    : current.plan;
                const next = { ...current, phase, goal, plan };
                return save(sessionId, {
                  ...next,
                  ledger: [
                    ...next.ledger,
                    event(current, "phase_changed", `${current.phase} -> ${phase}`),
                  ],
                });
              }),
            );
          }),
        ),

      controlGoal: (sessionId: string, action: WorkflowAction) =>
        serialize(
          sessionId,
          Effect.suspend(() => {
            const current = get(sessionId);
            const decision = evaluateWorkflowAction(current, { kind: "control", action });
            if (!decision.allowed)
              return Effect.fail(new WorkflowProgressRefused({ reason: decision.reason }));
            // An allowed control always has a goal; keep narrowing local to the mutation.
            if (current.goal === null)
              return Effect.fail(new WorkflowProgressRefused({ reason: "goal_missing" }));
            const currentGoal = current.goal;
            return Effect.sync(() =>
              atomic(() => {
                const now = new Date().toISOString();
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
                return save(sessionId, {
                  ...next,
                  ledger: [...next.ledger, event(current, kind, detail)],
                });
              }),
            );
          }),
        ),

      finishRun: (sessionId: string, startedPhase: WorkflowPhase) =>
        change(sessionId, (current) => {
          const now = new Date().toISOString();
          if (startedPhase === "execute" && current.phase === "execute") {
            const readyToVerify =
              current.plan !== null &&
              current.plan.status === "executing" &&
              current.plan.verification.status !== "failed" &&
              current.plan.steps.every(
                (step) => step.status === "completed" && step.evidence.length > 0,
              );
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
          const verified = current.plan.steps.every((step) => step.status === "completed");
          if (!verified) return current;
          // Native registration authorizes execution, not successful criterion coverage.
          // Legacy/unprovenanced Goals retain the release-compatible automatic completion.
          if (
            completion.required(sessionId) &&
            (!current.goal?.completion ||
              current.goal.completion.goalVersion !== current.goal.version ||
              current.goal.completion.planVersion !== current.plan.version)
          )
            return current;
          const goal = current.goal
            ? {
                ...current.goal,
                status: "completed" as const,
                verification: current.plan.verification,
                updatedAt: now,
              }
            : null;
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

      /** Direct owner transition requires a fully quiescent session. */
      startNewGoal: (sessionId: string, input: StartNewGoal) =>
        serialize(
          sessionId,
          Effect.try({
            try: () =>
              atomic(() => {
                if (
                  sqlite
                    .prepare(
                      "SELECT run_id FROM workflow_new_goal_requests WHERE session_id = ? AND status = 'accepted' LIMIT 1",
                    )
                    .get(sessionId)
                )
                  refuseNewGoal("transition_pending");
                return commitNewGoal(sessionId, input).state;
              }),
            catch: (cause) => {
              if (cause instanceof NewGoalTransitionRefused) return cause;
              throw cause;
            },
          }),
        ),

      /** Tool admission only records a durable request; never claims a new Goal was saved. */
      requestNewGoal: (sessionId: string, runId: string, input: StartNewGoal) =>
        serialize(
          sessionId,
          Effect.try({
            try: () =>
              atomic(() => {
                const existing = sqlite
                  .prepare(
                    "SELECT run_id, payload_json, status FROM workflow_new_goal_requests WHERE run_id = ?",
                  )
                  .get(runId);
                if (existing) {
                  if (
                    existing.run_id === runId &&
                    existing.payload_json === JSON.stringify(input) &&
                    existing.status === "accepted"
                  )
                    return { status: "accepted" as const, runId };
                  refuseNewGoal("transition_pending");
                }
                const run = sqlite
                  .prepare("SELECT thread_id, status FROM chat_runs WHERE run_id = ?")
                  .get(runId);
                if (!runId || run?.thread_id !== sessionId || run.status !== "running")
                  refuseNewGoal("run_outcome_uncertain");
                const pending = sqlite
                  .prepare(
                    "SELECT run_id FROM workflow_new_goal_requests WHERE session_id = ? AND status = 'accepted' LIMIT 1",
                  )
                  .get(sessionId);
                if (pending) refuseNewGoal("transition_pending");
                checkNewGoal(sessionId, input, runId);
                const binding = sqlite
                  .prepare(
                    "SELECT session_id, goal_instance_id, workflow_revision_id FROM workflow_run_bindings WHERE run_id = ?",
                  )
                  .get(runId);
                const revision = sqlite
                  .prepare(
                    "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                  )
                  .get(sessionId);
                if (
                  !revision ||
                  (binding &&
                    (binding.session_id !== sessionId ||
                      binding.goal_instance_id !== input.previousGoalInstanceId ||
                      binding.workflow_revision_id !== revision.id))
                )
                  return refuseNewGoal("workflow_changed");
                sqlite
                  .prepare(`
              INSERT INTO workflow_new_goal_requests
                (run_id, session_id, previous_goal_instance_id, source_revision_id,
                 payload_json, status, created_at)
              VALUES (?, ?, ?, ?, ?, 'accepted', ?)
            `)
                  .run(
                    runId,
                    sessionId,
                    input.previousGoalInstanceId,
                    revision.id,
                    JSON.stringify(input),
                    new Date().toISOString(),
                  );
                return { status: "accepted" as const, runId };
              }),
            catch: (cause) => {
              if (cause instanceof NewGoalTransitionRefused) return cause;
              throw cause;
            },
          }),
        ),

      /** Idempotent owner settlement. A failed or missing run can never apply its intent. */
      settleNewGoalRequest: (sessionId: string, runId: string) =>
        serialize(
          sessionId,
          Effect.sync(() =>
            atomic(() => {
              const row = sqlite
                .prepare(`
            SELECT session_id, payload_json, source_revision_id, status, reason, applied_goal_instance_id
            FROM workflow_new_goal_requests WHERE run_id = ?
          `)
                .get(runId);
              if (!row || row.session_id !== sessionId) return { status: "none" as const };
              if (row.status === "applied")
                return { status: "applied" as const, goalInstanceId: row.applied_goal_instance_id };
              if (row.status === "rejected")
                return { status: "rejected" as const, reason: row.reason };
              const run = sqlite
                .prepare("SELECT status FROM chat_runs WHERE run_id = ? AND thread_id = ?")
                .get(runId, sessionId);
              if (run?.status === "running" || run?.status === "interrupted")
                return { status: "accepted" as const };
              const reject = (reason: string) => {
                sqlite
                  .prepare(`
              UPDATE workflow_new_goal_requests SET status = 'rejected', reason = ?, settled_at = ?
              WHERE run_id = ? AND status = 'accepted'
            `)
                  .run(reason, new Date().toISOString(), runId);
                return { status: "rejected" as const, reason };
              };
              if (run?.status !== "completed") return reject("run_outcome_uncertain");
              const latest = sqlite
                .prepare(
                  "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get(sessionId);
              if (latest?.id !== row.source_revision_id) return reject("workflow_changed");
              try {
                const { newId } = commitNewGoal(
                  sessionId,
                  Schema.decodeUnknownSync(StartNewGoal)(JSON.parse(String(row.payload_json))),
                );
                sqlite
                  .prepare(`
              UPDATE workflow_new_goal_requests
              SET status = 'applied', applied_goal_instance_id = ?, settled_at = ?
              WHERE run_id = ? AND status = 'accepted'
            `)
                  .run(newId, new Date().toISOString(), runId);
                return { status: "applied" as const, goalInstanceId: newId };
              } catch (error) {
                if (error instanceof NewGoalTransitionRefused) return reject(error.reason);
                throw error;
              }
            }),
          ),
        ),

      updateGoal: (sessionId: string, input: UpdateGoal) =>
        change(sessionId, (current) => {
          // Only the first Goal in a new session is unambiguously new. A legacy Goal
          // without a recorded identity stays unbound; guessing it from text is unsafe.
          if (current.goal === null)
            insertGoalIdentity.run(sessionId, randomUUID(), new Date().toISOString());
          const goal: GoalArtifact = {
            ...input,
            evidence: [],
            verification: verificationDefault(),
            version: (current.goal?.version ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          };
          return {
            ...current,
            goal,
            ledger: [
              ...current.ledger,
              event(current, "goal_updated", `goal v${goal.version} (${goal.status})`),
            ],
          };
        }),

      updatePlan: (sessionId: string, input: UpdatePlan) =>
        change(sessionId, (current) => {
          const plan: PlanArtifact = {
            ...input,
            steps: input.steps.map((step) => ({
              ...step,
              status: "pending" as const,
              evidence: [],
            })),
            evidence: [],
            verification: verificationDefault(),
            version: (current.plan?.version ?? 0) + 1,
            goalVersion: current.goal?.version ?? 0,
            updatedAt: new Date().toISOString(),
          };
          const kind = current.plan === null ? "plan_updated" : "plan_replanned";
          const phase =
            current.phase === "execute" || current.phase === "verify" ? "plan" : current.phase;
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
                  event(planned, "phase_changed", `${current.phase} -> plan (plan revised)`),
                ],
              };
        }),

      updateProgress: (sessionId: string, input: UpdateWorkflowProgress, recorderRunId = "") =>
        serialize(
          sessionId,
          Effect.suspend(() => {
            const current = get(sessionId);
            if (input.goalStatus !== undefined && current.goal === null)
              return Effect.fail(new WorkflowProgressRefused({ reason: "goal_missing" }));
            if ((input.planStatus !== undefined || input.steps.length > 0) && current.plan === null)
              return Effect.fail(new WorkflowProgressRefused({ reason: "plan_missing" }));
            if (
              input.steps.some(
                (update) => !current.plan?.steps.some((step) => step.id === update.id),
              )
            )
              return Effect.fail(new WorkflowProgressRefused({ reason: "unknown_step" }));
            if (
              current.phase === "plan" &&
              (input.planStatus !== undefined ||
                input.steps.length > 0 ||
                input.planEvidence.length > 0 ||
                input.verification !== undefined)
            )
              return Effect.fail(new WorkflowProgressRefused({ reason: "phase_not_executable" }));

            const steps =
              current.plan?.steps.map((step) => {
                const update = input.steps.find((candidate) => candidate.id === step.id);
                if (!update) return step;
                return {
                  ...step,
                  status: update.status,
                  evidence: [...step.evidence, ...update.evidence],
                };
              }) ?? [];
            if (steps.some((step) => step.status === "completed" && step.evidence.length === 0))
              return Effect.fail(new WorkflowProgressRefused({ reason: "step_evidence_required" }));

            const verification = input.verification
              ? {
                  ...input.verification,
                  recoveryPhase: input.verification.recoveryPhase ?? null,
                  updatedAt: new Date().toISOString(),
                }
              : null;
            const goalVerification = verification ?? current.goal?.verification;
            if (
              input.goalStatus === "completed" &&
              (goalVerification?.status !== "passed" || goalVerification.evidence.length === 0)
            )
              return Effect.fail(new WorkflowProgressRefused({ reason: "verification_required" }));
            const planVerification = verification ?? current.plan?.verification;
            if (
              input.planStatus === "completed" &&
              (planVerification?.status !== "passed" || planVerification.evidence.length === 0)
            )
              return Effect.fail(new WorkflowProgressRefused({ reason: "verification_required" }));
            if (
              input.planStatus === "completed" &&
              steps.some((step) => step.status !== "completed")
            )
              return Effect.fail(new WorkflowProgressRefused({ reason: "steps_incomplete" }));

            return Effect.try({
              try: () =>
                atomic(() => {
                  let snapshot = current.goal?.completion;
                  if (input.criterionMappings !== undefined) {
                    const derived = completion.derive(
                      sessionId,
                      {
                        ...current,
                        plan: current.plan ? { ...current.plan, steps } : null,
                      },
                      input.criterionMappings,
                      recorderRunId,
                    );
                    if (derived.status === "refused")
                      throw new WorkflowProgressRefused({ reason: "completion_evidence_invalid" });
                    if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(derived.snapshot))
                      throw new WorkflowProgressRefused({ reason: "completion_snapshot_conflict" });
                    if (
                      goalVerification?.status !== "passed" ||
                      goalVerification.evidence.length === 0
                    )
                      throw new WorkflowProgressRefused({ reason: "verification_required" });
                    snapshot = derived.snapshot;
                  }
                  if (input.goalStatus === "completed" && completion.required(sessionId)) {
                    if (!snapshot)
                      throw new WorkflowProgressRefused({ reason: "completion_evidence_required" });
                    const checked = completion.derive(
                      sessionId,
                      {
                        ...current,
                        plan: current.plan ? { ...current.plan, steps } : null,
                      },
                      snapshot.mappings,
                      recorderRunId,
                    );
                    if (
                      checked.status === "refused" ||
                      JSON.stringify(checked.snapshot) !== JSON.stringify(snapshot)
                    )
                      throw new WorkflowProgressRefused({ reason: "completion_evidence_invalid" });
                  }
                  const now = new Date().toISOString();
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
                  const goal = current.goal
                    ? {
                        ...current.goal,
                        status: input.goalStatus ?? current.goal.status,
                        evidence: [...current.goal.evidence, ...input.goalEvidence],
                        verification: recordGoalVerification
                          ? verification
                          : current.goal.verification,
                        updatedAt: now,
                      }
                    : null;
                  if (goal && snapshot) goal.completion = snapshot;
                  const plan = current.plan
                    ? {
                        ...current.plan,
                        status: input.planStatus ?? current.plan.status,
                        steps,
                        evidence: [...current.plan.evidence, ...input.planEvidence],
                        verification: recordPlanVerification
                          ? verification
                          : current.plan.verification,
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
                  return save(sessionId, {
                    ...next,
                    ledger: [...next.ledger, event(current, kind, input.detail)],
                  });
                }),
              catch: (cause) => {
                if (cause instanceof WorkflowProgressRefused) return cause;
                throw cause;
              },
            });
          }),
        ),
    };
  });

/** Versioned Goal/Plan artifacts and their execution ledger, scoped to a session. */
export class Workflows extends Context.Service<
  Workflows,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/Workflows") {
  static readonly layer = Layer.effect(Workflows, make());
  /** Compatible code rollback disables only the new action; never deletes history or lowers schema. */
  static readonly layerWithOptions = (options: { readonly allowNewGoal: boolean }) =>
    Layer.effect(Workflows, make(options));
}
