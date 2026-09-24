import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { Context, Effect, Layer } from "effect";
import { AppEvents } from "../events/app-events.ts";
import {
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
  const runtime = yield* Effect.context<Workflows>();
  const run = Effect.runPromiseWith(runtime);

  return {
    forSession(sessionId: string, phase: WorkflowPhase): AnyServerTool[] {
      const updateGoal = toolDefinition({
        name: "update_goal",
        description:
          "Save the session's canonical Goal artifact. Use after discovering or revising the problem, outcomes, constraints, assumptions, non-goals, or blocking questions. This creates the next version.",
        inputSchema: toToolSchema(UpdateGoal),
      }).server((input) =>
        run(
          Effect.flatMap(Workflows, (workflows) => workflows.updateGoal(sessionId, input)).pipe(
            Effect.tap(() => Effect.sync(() => events.publishSession(sessionId, "run-state"))),
            Effect.map((state) => ({ phase: state.phase, goal: state.goal })),
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
          "Record durable Goal/Plan/step progress, evidence and verification. Plan and step progress is executable only while the workflow is in Execute or Verify; after update_plan returns the workflow to Plan, wait for Execute to be confirmed before recording it. Never call this in parallel with update_plan. Classify verification as passed, failed, invalid_hypothesis, invalid_criterion, inconclusive, or blocked instead of treating every non-pass as an implementation failure. Set recoveryPhase to goal or plan for invalid_hypothesis. A completed step needs evidence; a completed Goal or Plan needs passed verification with evidence; a completed Plan also needs every step completed.",
        inputSchema: toToolSchema(UpdateWorkflowProgress),
      }).server((input) =>
        run(
          exposeProgressRefusal(
            Effect.flatMap(Workflows, (workflows) =>
              workflows.updateProgress(sessionId, {
                ...input,
                steps: (input.steps ?? []).map((step) => ({
                  ...step,
                  evidence: step.evidence ?? [],
                })),
                goalEvidence: input.goalEvidence ?? [],
                planEvidence: input.planEvidence ?? [],
              }),
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
          return [updateGoal, updateProgress];
        case "plan":
          return [updateGoal, updatePlan];
        case "execute":
          return [updatePlan, updateProgress];
        case "verify":
          return [updateProgress];
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

export function workflowInstructions(state: WorkflowState, resolved: ResolvedRules) {
  const applicableRules = resolved.rules
    .map(
      (rule) =>
        `- ${rule.id}@${rule.version} (${rule.priority}; ${ruleSource(rule)}): ${rule.instruction}\n  Evidence: ${rule.requiredEvidence.join("; ") || "(none)"}`,
    )
    .join("\n");
  const common = `Workflow phase: ${state.phase}.
Goal and Plan are durable artifacts, not substitutes for a conversational answer.
Use only the workflow artifact tools available in this phase, and update an artifact when the user's decisions materially change it.
Never claim an artifact was stored unless its update tool completed.
Applicable workflow rules (reference these ids from Plan steps; do not copy their text into the artifact):
${applicableRules || "(none)"}${resolved.degraded.includes("embedding") ? "\nOptional semantic rule retrieval was unavailable; required metadata rules still apply." : ""}${resolved.degraded.includes("source") ? "\nOne or more optional structured rule sources were invalid or unreadable and were skipped." : ""}`;

  const goal = state.goal
    ? `Goal v${state.goal.version} (${state.goal.status}): ${state.goal.statement}
Outcomes:
${compactList(state.goal.outcomes)}
Blocking questions:
${compactList(state.goal.openQuestions.filter((question) => question.blocking).map((question) => question.question))}`
    : "Goal: not recorded yet.";

  switch (state.phase) {
    case "chat":
      return null;
    case "goal":
      return `${common}
The user delegated an outcome, not merely a request to describe a goal. Save a concise active Goal artifact before material changes, then autonomously investigate, implement and verify the outcome in this run. Replan internally as needed without requiring a Plan artifact. Use update_workflow_progress to record pauses, failures, evidence and verification. Do not mark the Goal completed without passed verification evidence. Ask only genuinely blocking questions. Tool permissions still apply.

${goal}`;
    case "plan": {
      const plan = state.plan
        ? `Plan v${state.plan.version} (${state.plan.status}, based on Goal v${state.plan.goalVersion}): ${state.plan.summary}`
        : "Plan: not recorded yet.";
      return `${common}
You are planning, not executing. Project tools are restricted to read-only investigation. If no Goal is recorded, infer the smallest useful Goal from the user's request and save it before the Plan; the user does not need to enter Goal mode first. Produce ordered steps with stable ids, dependencies, acceptance criteria, risks and applicable rule ids. Do not modify files, run commands, delegate work or present investigation as implementation.

${goal}

${plan}`;
    }
    case "execute":
      return `${common}
Execute only the current Plan. Before each step, record it as in_progress. Record completed steps with actual evidence using update_workflow_progress; never mark work complete from intention alone. If the user materially changes the scope, design or acceptance criteria, revise the Plan with update_plan; this returns the workflow to Plan so the revised version can be confirmed before execution resumes. The workflow advances to Verify only when every step is completed with evidence.

${goal}

${
  state.plan
    ? `Approved Plan v${state.plan.version}: ${state.plan.summary}
Current steps:
${state.plan.steps.map((step) => `- ${step.id} [${step.status}]: ${step.title}`).join("\n")}`
    : "Approved Plan: missing."
}`;
    case "verify":
      return `${common}
Verify the implementation against the Goal, Plan acceptance criteria and applicable rules. You have read/search tools and run_shell for builds, tests, linters and other non-mutating checks; actually run applicable checks instead of claiming this phase lacks tools. Do not edit files or install packages in Verify. First check whether the hypothesis and each criterion can actually distinguish the claimed cause. Record passed only with supporting evidence. Record failed only when valid criteria show an implementation defect; after you persist that failure the workflow automatically returns to Execute for repair. Use invalid_hypothesis when the premise is wrong (set recoveryPhase to goal or plan), invalid_criterion when the check itself is unsound, inconclusive when evidence cannot decide, and blocked only for a confirmed external dependency. Persist the result and evidence with update_workflow_progress. Do not invent settings, silently repair, waive a criterion, or ask the user to change workflow phases.

${goal}`;
  }
}
