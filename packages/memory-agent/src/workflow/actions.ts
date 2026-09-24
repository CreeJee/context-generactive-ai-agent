import type { LeaseView } from "../sessions/lease-state.ts";
import type { WorkflowAction, WorkflowPhase, WorkflowState } from "./workflow.ts";

export type WorkflowActionReason =
  | "session_in_use"
  | "run_in_progress"
  | "goal_missing"
  | "goal_not_active"
  | "goal_not_paused"
  | "goal_terminal"
  | "plan_not_ready"
  | "plan_outdated";

export type WorkflowActionDecision =
  | { readonly allowed: true; readonly intent?: "start" | "continue" }
  | { readonly allowed: false; readonly reason: WorkflowActionReason };

export interface WorkflowActions {
  readonly phases: Record<WorkflowPhase, WorkflowActionDecision>;
  readonly controls: Record<WorkflowAction, WorkflowActionDecision>;
}

export type WorkflowActionRequest =
  | { readonly kind: "phase"; readonly phase: WorkflowPhase }
  | { readonly kind: "control"; readonly action: WorkflowAction };

export interface WorkflowActionContext {
  readonly running?: boolean;
  readonly lease?: LeaseView;
}

/** Shared by snapshots and serialized mutations against the latest durable state. */
export function evaluateWorkflowAction(
  state: WorkflowState,
  request: WorkflowActionRequest,
  context: WorkflowActionContext = {},
): WorkflowActionDecision {
  if (context.lease?.state === "other") return { allowed: false, reason: "session_in_use" };
  if (context.running && (request.kind === "phase" || request.action === "resume"))
    return { allowed: false, reason: "run_in_progress" };
  const { goal, plan } = state;
  if (request.kind === "phase") {
    // Non-execution phase navigation does not approve or mutate artifacts.
    if (request.phase !== "execute") return { allowed: true };
    if (goal && plan && plan.goalVersion !== goal.version)
      return { allowed: false, reason: "plan_outdated" };
    if (!goal || !plan || (plan.status !== "ready" && plan.status !== "executing"))
      return { allowed: false, reason: "plan_not_ready" };
    return { allowed: true, intent: plan.status === "executing" ? "continue" : "start" };
  }
  if (!goal) return { allowed: false, reason: "goal_missing" };
  if (goal.status === "completed" || goal.status === "failed")
    return { allowed: false, reason: "goal_terminal" };
  if (request.action === "pause" && goal.status === "paused")
    return { allowed: false, reason: "goal_not_active" };
  if (request.action === "resume" && goal.status !== "paused")
    return { allowed: false, reason: "goal_not_paused" };
  return { allowed: true };
}

export function workflowActions(
  state: WorkflowState,
  context: WorkflowActionContext = {},
): WorkflowActions {
  const phase = (value: WorkflowPhase) =>
    evaluateWorkflowAction(state, { kind: "phase", phase: value }, context);
  const control = (value: WorkflowAction) =>
    evaluateWorkflowAction(state, { kind: "control", action: value }, context);
  return {
    phases: {
      chat: phase("chat"),
      goal: phase("goal"),
      plan: phase("plan"),
      execute: phase("execute"),
      verify: phase("verify"),
    },
    controls: { pause: control("pause"), resume: control("resume"), stop: control("stop") },
  };
}
