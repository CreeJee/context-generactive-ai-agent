import { Data, Function as EffectFunction, Predicate, Schema } from "effect";
import { isTruthy } from "../truthy.ts";
import type { LeaseView } from "../sessions/lease-state.ts";
import type { WorkflowAction, WorkflowPhase, WorkflowState } from "./workflow.ts";

export const WorkflowActionReason = Schema.Literals([
  "session_in_use",
  "run_in_progress",
  "goal_missing",
  "goal_not_active",
  "goal_not_paused",
  "goal_terminal",
  "plan_not_ready",
  "plan_outdated",
]);
export type WorkflowActionReason = typeof WorkflowActionReason.Type;

export type WorkflowActionDecision =
  | { readonly allowed: true; readonly intent?: "start" | "continue" }
  | { readonly allowed: false; readonly reason: WorkflowActionReason };

export interface WorkflowActions {
  readonly phases: Record<WorkflowPhase, WorkflowActionDecision>;
  readonly controls: Record<WorkflowAction, WorkflowActionDecision>;
}

export type WorkflowActionRequest = Data.TaggedEnum<{
  phase: { readonly phase: WorkflowPhase };
  control: { readonly action: WorkflowAction };
}>;
export const WorkflowActionRequest = Data.taggedEnum<WorkflowActionRequest>();

export interface WorkflowActionContext {
  readonly running?: boolean;
  readonly lease?: LeaseView;
}

/** Shared by snapshots and serialized mutations against the latest durable state. */
const isActionRequest = Predicate.or(
  WorkflowActionRequest.$is("phase"),
  WorkflowActionRequest.$is("control"),
);
export const evaluateWorkflowAction: {
  (request: WorkflowActionRequest): (state: WorkflowState) => WorkflowActionDecision;
  (
    request: WorkflowActionRequest,
    context: WorkflowActionContext,
  ): (state: WorkflowState) => WorkflowActionDecision;
  (state: WorkflowState, request: WorkflowActionRequest): WorkflowActionDecision;
  (
    state: WorkflowState,
    request: WorkflowActionRequest,
    context: WorkflowActionContext,
  ): WorkflowActionDecision;
} = EffectFunction.dual((args) => !isActionRequest(args[0]), evaluateWorkflowActionBody);
function evaluateWorkflowActionBody(
  state: WorkflowState,
  request: WorkflowActionRequest,
  context: WorkflowActionContext = {},
): WorkflowActionDecision {
  if (context.lease?.state === "other") return { allowed: false, reason: "session_in_use" };
  if (
    context.running === true &&
    (WorkflowActionRequest.$is("phase")(request) || request.action === "resume")
  )
    return { allowed: false, reason: "run_in_progress" };
  const { goal, plan } = state;
  return WorkflowActionRequest.$match(request, {
    phase: ({ phase }): WorkflowActionDecision => {
      // Completion is a server-owned terminal phase, never a user navigation target.
      if (phase === "completed") return { allowed: false, reason: "goal_terminal" };
      // Non-execution phase navigation does not approve or mutate artifacts.
      if (phase !== "execute") return { allowed: true };
      if (isTruthy(goal) && isTruthy(plan) && plan.goalVersion !== goal.version)
        return { allowed: false, reason: "plan_outdated" };
      if (
        !isTruthy(goal) ||
        !isTruthy(plan) ||
        (plan.status !== "ready" && plan.status !== "executing")
      )
        return { allowed: false, reason: "plan_not_ready" };
      return { allowed: true, intent: plan.status === "executing" ? "continue" : "start" };
    },
    control: ({ action }): WorkflowActionDecision => {
      if (!isTruthy(goal)) return { allowed: false, reason: "goal_missing" };
      if (goal.status === "completed" || goal.status === "failed")
        return { allowed: false, reason: "goal_terminal" };
      if (action === "pause" && goal.status === "paused")
        return { allowed: false, reason: "goal_not_active" };
      if (action === "resume" && goal.status !== "paused")
        return { allowed: false, reason: "goal_not_paused" };
      return { allowed: true };
    },
  });
}

const isStateInput = Schema.is(Schema.Struct({ phase: Schema.String }));
export const workflowActions: {
  (): (state: WorkflowState) => WorkflowActions;
  (context: WorkflowActionContext): (state: WorkflowState) => WorkflowActions;
  (state: WorkflowState): WorkflowActions;
  (state: WorkflowState, context: WorkflowActionContext): WorkflowActions;
} = EffectFunction.dual((args) => isStateInput(args[0]), workflowActionsBody);
function workflowActionsBody(
  state: WorkflowState,
  context: WorkflowActionContext = {},
): WorkflowActions {
  const phase = (value: WorkflowPhase) =>
    evaluateWorkflowAction(state, WorkflowActionRequest.phase({ phase: value }), context);
  const control = (value: WorkflowAction) =>
    evaluateWorkflowAction(state, WorkflowActionRequest.control({ action: value }), context);
  return {
    phases: {
      chat: phase("chat"),
      goal: phase("goal"),
      plan: phase("plan"),
      execute: phase("execute"),
      verify: phase("verify"),
      completed: phase("completed"),
    },
    controls: { pause: control("pause"), resume: control("resume"), stop: control("stop") },
  };
}
