import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { Context, Effect, Layer } from "effect";
import { AppEvents } from "../events/app-events.ts";
import {
  StartNewGoal,
  UpdateGoal,
  UpdatePlan,
  UpdateWorkflowProgress,
  WorkflowProgressRefused,
  Workflows,
  type WorkflowPhase,
  type WorkflowState,
} from "./workflow.ts";
import { toToolSchema } from "../tools/schema.ts";
import type { ResolvedRules } from "./rules.ts";
import { WorkflowBlocker, WorkflowExecution } from "./execution.ts";

const exposeProgressRefusal = <A, R>(effect: Effect.Effect<A, WorkflowProgressRefused, R>) =>
  effect.pipe(
    Effect.catchTag("WorkflowProgressRefused", (failure) =>
      Effect.succeed({
        error: "workflow_progress_refused" as const,
        reason: failure.reason,
      }),
    ),
  );

const make = Effect.gen(function* () {
  const events = yield* AppEvents;
  const runtime = yield* Effect.context<Workflows | WorkflowExecution>();
  const run = Effect.runPromiseWith(runtime);

  return {
    forSession(sessionId: string, phase: WorkflowPhase, runId = ""): AnyServerTool[] {
      const recordBlocker = toolDefinition({
        name: "record_workflow_blocker",
        description:
          "Stop automatic Plan execution only for a confirmed user decision, permission wait, external dependency or repeated failed approach. Record the concrete missing requirement and actual evidence. Unfinished investigation, review, preparation or verification that you can perform is remaining work, not a blocker. Continue all independent work before recording a blocker.",
        inputSchema: toToolSchema(WorkflowBlocker),
      }).server((input) =>
        run(
          Effect.gen(function* () {
            const result = yield* (yield* WorkflowExecution).block(sessionId, runId, input);
            events.publishSession(sessionId, "run-state");
            return result;
          }),
        ),
      );
      const startNewGoal = toolDefinition({
        name: "start_new_goal",
        description:
          "Request a separate independent-success Goal from Goal, Plan or a verified completed workflow. Requires the exact current Goal instance ID from the workflow prompt (null only for legacy/unbound); the owner rechecks it. A live calling run cannot apply the transition immediately. Preserves prior Goal/Plan/run evidence without inheriting verification. Purpose revisions use update_goal; method changes use update_plan. Never bypass an active/failed run or uncertain side effect.",
        inputSchema: toToolSchema(StartNewGoal),
      }).server((input) =>
        run(
          Effect.gen(function* () {
            const workflows = yield* Workflows;
            if (runId) {
              const request = yield* workflows.requestNewGoal(sessionId, runId, input);
              return {
                ...request,
                applied: false as const,
                message:
                  "Request accepted; the new Goal is not saved. It will be applied only after this run completes and owner safety checks pass.",
              };
            }
            const state = yield* workflows.startNewGoal(sessionId, input);
            const goalInstanceId = yield* workflows.goalInstanceId(sessionId);
            return { phase: state.phase, goal: state.goal, plan: state.plan, goalInstanceId };
          }).pipe(
            Effect.tap(() => Effect.sync(() => events.publishSession(sessionId, "run-state"))),
            Effect.catchTag("NewGoalTransitionRefused", (failure) =>
              Effect.succeed({
                error: "new_goal_transition_refused" as const,
                reason: failure.reason,
              }),
            ),
          ),
        ),
      );
      const updateGoal = toolDefinition({
        name: "update_goal",
        description:
          "Save the session's canonical Goal artifact. Use after discovering or revising the problem, outcomes, constraints, assumptions, non-goals, or blocking questions. This creates the next version.",
        inputSchema: toToolSchema(UpdateGoal),
      }).server((input) =>
        run(
          Effect.flatMap(Workflows, (workflows) => workflows.updateGoal(sessionId, input)).pipe(
            Effect.tap(() => Effect.sync(() => events.publishSession(sessionId, "run-state"))),
            Effect.flatMap((state) =>
              Effect.flatMap(Workflows, (workflows) =>
                Effect.map(workflows.goalInstanceId(sessionId), (goalInstanceId) => ({
                  phase: state.phase,
                  goal: state.goal,
                  goalInstanceId,
                })),
              ),
            ),
          ),
        ),
      );

      const updatePlan = toolDefinition({
        name: "update_plan",
        description:
          "Save the session's canonical Plan artifact. Use after making or revising an actionable plan. Each step needs stable ids, dependencies, acceptance criteria and applicable workflow rule ids. This creates the next version. Revising a Plan during Execute returns the workflow to Plan and invalidates concurrent or later progress calls from that turn; do not call update_workflow_progress in parallel with update_plan.",
        inputSchema: toToolSchema(UpdatePlan),
      }).server((input) =>
        run(
          Effect.flatMap(Workflows, (workflows) => workflows.updatePlan(sessionId, input)).pipe(
            Effect.tap(() => Effect.sync(() => events.publishSession(sessionId, "run-state"))),
            Effect.map((state) => ({ phase: state.phase, plan: state.plan })),
          ),
        ),
      );

      const updateProgress = toolDefinition({
        name: "update_workflow_progress",
        description:
          "Record durable Goal/Plan/step progress, evidence and verification. Plan and step progress is executable only while the workflow is in Execute or Verify; after update_plan returns the workflow to Plan, wait for Execute to be confirmed before recording it. Never call this in parallel with update_plan. Classify verification as passed, failed, invalid_hypothesis, invalid_criterion, inconclusive, or blocked instead of treating every non-pass as an implementation failure. Set recoveryPhase to goal or plan for invalid_hypothesis. A completed step needs evidence; a completed Goal or Plan needs passed verification with evidence; a completed Plan also needs every step completed. Provenance-bound Goals also require criterionMappings covering every current outcome: freeze outcomeIndex/outcomeText and stepId/acceptanceIndex/acceptanceText from the current Plan, with actual runId and successful verification tool-result evidenceNodeIds. Only current Goal/Plan versions are supported; registration is execution authorization, not passed proof. The owner derives provenance and recorder identity, never accept those from input.",
        inputSchema: toToolSchema(UpdateWorkflowProgress),
      }).server((input) =>
        run(
          exposeProgressRefusal(
            Effect.flatMap(Workflows, (workflows) =>
              workflows.updateProgress(
                sessionId,
                {
                  ...input,
                  steps: (input.steps ?? []).map((step) => ({
                    ...step,
                    evidence: step.evidence ?? [],
                  })),
                  goalEvidence: input.goalEvidence ?? [],
                  planEvidence: input.planEvidence ?? [],
                },
                runId,
              ),
            ).pipe(
              Effect.tap(() => Effect.sync(() => events.publishSession(sessionId, "run-state"))),
              Effect.map((state) => ({
                phase: state.phase,
                goal: state.goal,
                plan: state.plan,
              })),
            ),
          ),
        ),
      );

      switch (phase) {
        case "goal":
          return [updateGoal, updateProgress, startNewGoal];
        case "plan":
          return [updateGoal, updatePlan, startNewGoal];
        case "execute":
          return [updatePlan, updateProgress, recordBlocker];
        case "verify":
          return [updateProgress, recordBlocker, startNewGoal];
        case "completed":
          return [startNewGoal];
        case "chat":
          return [];
      }
    },
  };
});

/** Tools that write only workflow artifacts, never project files. */
export class WorkflowTools extends Context.Service<WorkflowTools, Effect.Success<typeof make>>()(
  "memory-agent/WorkflowTools",
) {
  static readonly layer = Layer.effect(WorkflowTools, make);
}

const compactList = (items: readonly string[], limit = 6) =>
  items.length === 0
    ? "(none)"
    : items
        .slice(0, limit)
        .map((item) => `- ${item}`)
        .join("\n");

const ruleSource = (rule: ResolvedRules["rules"][number]) => {
  switch (rule.source.kind) {
    case "builtin":
      return `builtin:${rule.source.name}`;
    case "project":
      return `project:${rule.source.path}#${rule.source.contentHash.slice(0, 12)}`;
    case "skill":
      return `skill:${rule.source.scope}/${rule.source.name}#${rule.source.contentHash.slice(0, 12)}`;
    case "mcp-resource":
    case "mcp-prompt":
      return `${rule.source.kind}:${rule.source.serverId}/${rule.source.name}#${rule.source.contentHash.slice(0, 12)}`;
  }
};

export function workflowInstructions(
  state: WorkflowState,
  resolved: ResolvedRules,
  goalInstanceId: string | null = null,
) {
  const applicableRules = resolved.rules
    .map(
      (rule) =>
        `- ${rule.id}@${rule.version} (${rule.priority}; ${ruleSource(rule)}): ${rule.instruction}\n  Evidence: ${rule.requiredEvidence.join("; ") || "(none)"}`,
    )
    .join("\n");
  const common = `Workflow phase: ${state.phase}.
Current Goal instance ID: ${goalInstanceId ?? "(none; legacy/unbound)"}. For start_new_goal, use this exact ID as previousGoalInstanceId (null only if none). This is a snapshot; the owner checks the current ID again at request time.
Goal and Plan are durable artifacts, not substitutes for a conversational answer.
Use only the workflow artifact tools available in this phase, and update an artifact when the user's decisions materially change it.
Never claim an artifact was stored unless its update tool completed.
Applicable workflow rules (reference these ids from Plan steps; do not copy their text into the artifact):
${applicableRules || "(none)"}${resolved.degraded.includes("embedding") ? "\nOptional semantic rule retrieval was unavailable; required metadata rules still apply." : ""}${resolved.degraded.includes("source") ? "\nOne or more optional structured rule sources were invalid or unreadable and were skipped." : ""}`;

  const goal = state.goal
    ? `Goal v${state.goal.version} (${state.goal.status}): ${state.goal.statement}
Outcomes:
${compactList(state.goal.outcomes)}
Constraints (apply across every continuation; a new turn does not reset limits):
${compactList(state.goal.constraints, state.goal.constraints.length)}
Non-goals:
${compactList(state.goal.nonGoals, state.goal.nonGoals.length)}
Blocking questions:
${compactList(state.goal.openQuestions.filter((question) => question.blocking).map((question) => question.question))}`
    : "Goal: not recorded yet.";

  switch (state.phase) {
    case "chat":
      return null;
    case "completed":
      return `${common}\nThe Goal and Plan are complete. Do not resume verification or change their completed evidence. Answer follow-up questions conversationally. Start a new Goal only when the user explicitly requests new work.\n\n${goal}`;
    case "goal":
      return `${common}
The user delegated an outcome, not merely a request to describe a goal. Save a concise active Goal artifact before material changes, then autonomously investigate, implement and verify the outcome in this run. Replan internally as needed without requiring a Plan artifact. Use update_workflow_progress to record pauses, failures, evidence and verification. Do not mark the Goal completed without passed verification evidence. Ask only genuinely blocking questions. Tool permissions still apply.

${goal}`;
    case "plan": {
      const plan = state.plan
        ? `Plan v${state.plan.version} (${state.plan.status}, based on Goal v${state.plan.goalVersion}): ${state.plan.summary}`
        : "Plan: not recorded yet.";
      return `${common}
You are planning, not executing. Project tools are restricted to read-only investigation. If no Goal is recorded, infer the smallest useful Goal from the user's request and save it before the Plan; the user does not need to enter Goal mode first. Produce ordered steps with stable ids, dependencies, acceptance criteria, risks and applicable rule ids. When a contradiction or unanswered question arises, record what is uncertain and which decisions depend on it; continue all independent read-only investigation and planning before asking. Narrow questions with evidence and ask only when no useful independent planning remains and the decision truly blocks progress. A non-blocking open question does not by itself require a draft Plan: save a ready Plan when its steps can proceed, and leave the unresolved decision for the step it actually affects. Never assume an answer to a blocking question or mark a Plan ready if the unresolved decision prevents safe execution of its next step. Do not modify files, run commands, delegate work or present investigation as implementation.

${goal}

${plan}`;
    }
    case "execute":
      return `${common}
Execute only the current Plan. On a request to resume the approved work, continue an existing in_progress step from its recorded evidence rather than merely listing remaining tasks or restarting completed work. A request to continue an answer, explain status or discuss the Plan is not by itself execution intent or new approval; answer that request without claiming work was performed. When the wording is ambiguous, use the surrounding conversation and ask if execution intent remains unclear. Resume requests never waive Goal constraints, failed-approach limits, pending permissions or a confirmed blocker. Before each step, record it as in_progress. Record completed steps with actual evidence using update_workflow_progress; never mark work complete from intention alone. If the user materially changes the scope, design or acceptance criteria, revise the Plan with update_plan; this returns the workflow to Plan so the revised version can be confirmed before execution resumes. The workflow advances to Verify only when every step is completed with evidence.
Continue the approved work through implementation, preparation, review and verification that you can perform. Do not end a turn merely promising to investigate or review next. After partial progress, persist new evidence with update_workflow_progress and continue. If progress genuinely requires a user decision, permission, an external dependency or recovery from a repeated failed approach, finish all independent work and record_workflow_blocker with the concrete reason and evidence before answering. Unverified work is remaining work to perform, not itself a reason to stop. The server continues unfinished approved execution automatically while executable; ending your answer does not pause the Plan. Successful file modifications and new substantive successful tool results also count as progress before a step completes. Identical repeated reads, no-op writes, failed calls and permission refusals do not reset the two-consecutive-turn no-progress limit. Automatic continuation never grants new permission or bypasses a pending approval, confirmed blocker, user stop or failed run.
When repairing failed verification, use the recorded failure evidence, perform the repair, and persist the repair evidence plus verification status not_run before returning to Verify.

${goal}

${
  state.plan
    ? `Approved Plan v${state.plan.version}: ${state.plan.summary}
Current steps:
${state.plan.steps.map((step) => `- ${step.id} [${step.status}]: ${step.title}${step.status === "completed" ? "" : `\n  Description: ${step.description}\n  Depends on: ${step.dependsOn.join(", ") || "(none)"}\n  Acceptance criteria:\n${compactList(step.acceptanceCriteria, step.acceptanceCriteria.length)}\n  Rule refs: ${step.ruleRefs.join(", ") || "(none)"}\n  Recent evidence (historical evidence is not fresh verification):\n${compactList(step.evidence.slice(-6))}`}`).join("\n")}`
    : "Approved Plan: missing."
}`;
    case "verify":
      return `${common}
Verify the implementation against the Goal, Plan acceptance criteria and applicable rules. You have read/search tools and run_shell for builds, tests, linters and other non-mutating checks; actually run applicable checks instead of claiming this phase lacks tools. Do not edit files or install packages in Verify. First check whether the hypothesis and each criterion can actually distinguish the claimed cause. Record passed only with supporting evidence. Record failed only when valid criteria show an implementation defect; after you persist that failure the workflow automatically returns to Execute for repair. Use invalid_hypothesis when the premise is wrong (set recoveryPhase to goal or plan), invalid_criterion when the check itself is unsound, inconclusive when evidence cannot decide, and blocked only for a confirmed external dependency. Persist the result and evidence with update_workflow_progress. Do not invent settings, silently repair, waive a criterion, or ask the user to change workflow phases.
Perform applicable review and checks now instead of ending with a promise to do them later. If a confirmed dependency prevents all independent verification, record_workflow_blocker with its reason and evidence.

${goal}`;
  }
}
