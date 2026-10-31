import { Data, Function as EffectFunction, Match, Predicate, Schema } from "effect";
import type { LeaseView } from "../sessions/lease-state.ts";
import {
  GoalEvent,
  goalStateOf,
  goalTransitions,
  standingOf,
  type Transition,
} from "./goal-transitions.ts";
import type { WorkflowActionDecision, WorkflowActionReason, WorkflowActions } from "./contracts.ts";
import type { WorkflowAction, WorkflowPhase, WorkflowState } from "./workflow.ts";

export { WorkflowActionDecision, WorkflowActionReason, WorkflowActions } from "./contracts.ts";

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
  const goalState = goalStateOf(standingOf(state));
  const decided = (outcome: Transition<WorkflowActionReason>): WorkflowActionDecision =>
    outcome._tag === "Refused" ? { allowed: false, reason: outcome.reason } : { allowed: true };
  return WorkflowActionRequest.$match(request, {
    phase: ({ phase }): WorkflowActionDecision => {
      if (phase !== "execute")
        return decided(goalTransitions.Navigated(goalState, GoalEvent.Navigated({ phase })));
      const approved = decided(
        goalTransitions.ExecutionApproved(goalState, GoalEvent.ExecutionApproved()),
      );
      return approved.allowed
        ? { allowed: true, intent: state.plan?.status === "executing" ? "continue" : "start" }
        : approved;
    },
    control: ({ action }): WorkflowActionDecision =>
      decided(
        Match.value(action).pipe(
          Match.when("pause", () => goalTransitions.GoalPaused(goalState, GoalEvent.GoalPaused())),
          Match.when("resume", () =>
            goalTransitions.GoalResumed(goalState, GoalEvent.GoalResumed()),
          ),
          Match.when("stop", () => goalTransitions.GoalStopped(goalState, GoalEvent.GoalStopped())),
          Match.exhaustive,
        ),
      ),
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
