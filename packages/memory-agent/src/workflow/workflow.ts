import type { SQLOutputValue } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { Database } from "../db/database.ts";
import { evaluateWorkflowAction, type WorkflowActionReason } from "./actions.ts";

export const WorkflowPhase = Schema.Literal("chat", "goal", "plan", "execute", "verify");
export type WorkflowPhase = typeof WorkflowPhase.Type;

export const WorkflowAction = Schema.Literal("pause", "resume", "stop");
export type WorkflowAction = typeof WorkflowAction.Type;

const GoalQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  blocking: Schema.Boolean,
});

export const VerificationStatus = Schema.Literal(
  "not_run",
  "passed",
  "failed",
  "invalid_hypothesis",
  "invalid_criterion",
  "inconclusive",
  "blocked",
);
export type VerificationStatus = typeof VerificationStatus.Type;

const Verification = Schema.Struct({
  status: VerificationStatus,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  recoveryPhase: Schema.optionalWith(Schema.NullOr(Schema.Literal("goal", "plan")), {
    default: () => null,
  }),
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
  version: Schema.Int,
  statement: Schema.String,
  outcomes: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  nonGoals: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  openQuestions: Schema.Array(GoalQuestion),
  evidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  verification: Schema.optionalWith(Verification, { default: verificationDefault }),
  updatedAt: Schema.String,
} as const;

export const GoalArtifact = Schema.Struct({
  ...goalFields,
  status: Schema.Literal("draft", "active", "paused", "completed", "failed"),
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
  status: Schema.Literal("pending", "in_progress", "completed", "blocked"),
  evidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});
export type PlanStep = typeof PlanStep.Type;

const planFields = {
  version: Schema.Int,
  goalVersion: Schema.Int,
  summary: Schema.String,
  steps: Schema.Array(PlanStep),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  evidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  verification: Schema.optionalWith(Verification, { default: verificationDefault }),
  updatedAt: Schema.String,
} as const;

export const PlanArtifact = Schema.Struct({
  ...planFields,
  status: Schema.Literal("draft", "ready", "executing", "completed", "blocked"),
});
export type PlanArtifact = typeof PlanArtifact.Type;

const LedgerEvent = Schema.Struct({
  sequence: Schema.Int,
  at: Schema.String,
  kind: Schema.Literal(
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
  ),
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
  status: Schema.Literal("draft", "active"),
});
export type UpdateGoal = typeof UpdateGoal.Type;

export const UpdatePlan = Schema.Struct({
  summary: Schema.String,
  steps: Schema.Array(Schema.Struct(planStepFields)),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  status: Schema.Literal("draft", "ready"),
});
export type UpdatePlan = typeof UpdatePlan.Type;

const StepProgress = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("pending", "in_progress", "completed", "blocked"),
  evidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});

const VerificationUpdate = Schema.Struct({
  status: VerificationStatus,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  recoveryPhase: Schema.optional(Schema.NullOr(Schema.Literal("goal", "plan"))),
});

export const UpdateWorkflowProgress = Schema.Struct({
  goalStatus: Schema.optional(Schema.Literal("active", "paused", "completed", "failed")),
  planStatus: Schema.optional(Schema.Literal("executing", "completed", "blocked")),
  steps: Schema.optionalWith(Schema.Array(StepProgress), { default: () => [] }),
  goalEvidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  planEvidence: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  verification: Schema.optional(VerificationUpdate),
  detail: Schema.String,
});
export type UpdateWorkflowProgress = typeof UpdateWorkflowProgress.Type;

const emptyState = (): WorkflowState => ({ phase: "chat", goal: null, plan: null, ledger: [] });

// Read workflow rows written before execution state and evidence became durable fields.
const PersistedGoalArtifact = Schema.Struct({
  ...goalFields,
  status: Schema.Literal("draft", "ready", "confirmed", "active", "paused", "completed", "failed"),
});
const PersistedPlanArtifact = Schema.Struct({
  ...planFields,
  status: Schema.Literal("draft", "ready", "approved", "executing", "completed", "blocked"),
});
const PersistedWorkflowState = Schema.Struct({
  phase: WorkflowPhase,
  goal: Schema.NullOr(PersistedGoalArtifact),
  plan: Schema.NullOr(PersistedPlanArtifact),
  ledger: Schema.Array(LedgerEvent),
});
const decodePersistedState = Schema.decodeUnknownSync(Schema.parseJson(PersistedWorkflowState));
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
const encodeState = Schema.encodeSync(Schema.parseJson(WorkflowState));
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
    | "phase_not_executable";
}> {}

function rowText(row: Record<string, SQLOutputValue> | undefined) {
  return row ? decodeRow(row).state_json : null;
}

const implementationComplete = (plan: PlanArtifact) =>
  plan.steps.every((step) => step.status === "completed" && step.evidence.length > 0);

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

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;
  const serialize = keyedSerialLimit();
  const select = sqlite.prepare("SELECT state_json FROM session_workflows WHERE session_id = ?");
  const upsert = sqlite.prepare(`
    INSERT INTO session_workflows (session_id, state_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `);

  const get = (sessionId: string): WorkflowState => {
    const json = rowText(select.get(sessionId));
    return json === null ? emptyState() : decodeState(json);
  };
  const save = (sessionId: string, state: WorkflowState) => {
    upsert.run(sessionId, encodeState(state), new Date().toISOString());
    return state;
  };
  const change = (sessionId: string, update: (current: WorkflowState) => WorkflowState) =>
    serialize(
      sessionId,
      Effect.sync(() => atomic(() => save(sessionId, update(get(sessionId))))),
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

  return {
    get: (sessionId: string) => Effect.sync(() => get(sessionId)),

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
                event(current, "phase_changed", `${current.phase} -> ${phase} (state reconciled)`),
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
        if (startedPhase !== "verify" || current.phase !== "verify" || current.plan === null)
          return current;
        const verification = current.plan.verification;
        if (verification.status === "not_run" || verification.evidence.length === 0) return current;
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
                    event(current, "phase_changed", `verify -> ${phase} (${verification.status})`),
                  ],
          };
        }
        const verified = current.plan.steps.every((step) => step.status === "completed");
        if (!verified) return current;
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
          goal,
          plan,
          ledger: [
            ...current.ledger,
            event(current, "progress_updated", "Verification completed the workflow"),
          ],
        };
      }),

    updateGoal: (sessionId: string, input: UpdateGoal) =>
      change(sessionId, (current) => {
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
          steps: input.steps.map((step) => ({ ...step, status: "pending" as const, evidence: [] })),
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

    updateProgress: (sessionId: string, input: UpdateWorkflowProgress) =>
      serialize(
        sessionId,
        Effect.suspend(() => {
          const current = get(sessionId);
          if (input.goalStatus !== undefined && current.goal === null)
            return Effect.fail(new WorkflowProgressRefused({ reason: "goal_missing" }));
          if ((input.planStatus !== undefined || input.steps.length > 0) && current.plan === null)
            return Effect.fail(new WorkflowProgressRefused({ reason: "plan_missing" }));
          if (
            input.steps.some((update) => !current.plan?.steps.some((step) => step.id === update.id))
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
          if (input.planStatus === "completed" && steps.some((step) => step.status !== "completed"))
            return Effect.fail(new WorkflowProgressRefused({ reason: "steps_incomplete" }));

          return Effect.sync(() =>
            atomic(() => {
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
                    verification: recordGoalVerification ? verification : current.goal.verification,
                    updatedAt: now,
                  }
                : null;
              const plan = current.plan
                ? {
                    ...current.plan,
                    status: input.planStatus ?? current.plan.status,
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
              return save(sessionId, {
                ...next,
                ledger: [...next.ledger, event(current, kind, input.detail)],
              });
            }),
          );
        }),
      ),
  };
});

/** Versioned Goal/Plan artifacts and their execution ledger, scoped to a session. */
export class Workflows extends Context.Tag("memory-agent/Workflows")<
  Workflows,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(Workflows, make);
}
