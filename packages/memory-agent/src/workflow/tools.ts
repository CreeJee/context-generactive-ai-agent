import { isTruthy } from "../truthy.ts";
import { Context, Effect, Function as EffectFunction, Layer, Match, Schema } from "effect";
import { AppEvents } from "../events/app-events.ts";
import {
  StartNewGoal,
  UpdateGoal,
  UpdatePlan,
  Workflows,
  type PlanStep,
  type WorkflowPhase,
  WorkflowState,
} from "./workflow.ts";
import { runTool, type RunTool, type ToolCall } from "../tools/run-tool.ts";
import { RuleSource, type ResolvedRules } from "./rules.ts";
import { unknownStepOutcomeText } from "./step-outcomes.ts";
import { OutcomeStatus, outcomeStatusWord, type OutcomeStanding } from "./outcome-ledger.ts";
import { WorkflowExecution } from "./execution.ts";
import { BoardAuthor, stepProgressStatus } from "./card.ts";
import { cardCapabilities } from "./card-capabilities.ts";
import { EditPlan, type GoalOutcome } from "./contracts.ts";
import { EditGoal } from "./goal-edit.ts";
import {
  PlanDependencyIssue,
  planDependencyIssues,
  PlanSchedule,
  planSchedule,
  unmetDependencyText,
} from "./plan-schedule.ts";

const ClosePlanInput = Schema.Struct({
  reason: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isMinLength(1))).annotate({
    description:
      "Why the remaining work is not needed, such as which conversation or agent already did it.",
  }),
});

const startNewGoal = {
  name: "start_new_goal",
  description:
    "Request a separate independent-success Goal from Goal, Plan or a verified completed workflow. Requires the exact current Goal instance ID from the workflow prompt (null only for legacy/unbound); the owner rechecks it. A live calling run cannot apply the transition immediately. Preserves prior Goal/Plan/run evidence without inheriting verification. Purpose revisions use update_goal; method changes use update_plan. Never bypass an active/failed run or uncertain side effect.",
  parameters: StartNewGoal,
} as const;

const updateGoal = {
  name: "update_goal",
  description:
    "Save the whole canonical Goal artifact. Use to write a Goal or rewrite most of it; to change a few parts use edit_goal, which does not resend the Goal. Use after discovering or revising the problem, outcomes, constraints, assumptions, non-goals, or blocking questions. This creates the next version. Reflect explicit user decisions, including an authorized change to implementation scope, without asking for the same approval again. Never remove constraints or non-goals merely to make execution possible. Revising a Goal while its Plan runs returns the workflow to shaping, unless a kanban board runs it; synchronize the Plan with the new Goal before running it is confirmed.",
  parameters: UpdateGoal,
} as const;

const editGoal = {
  name: "edit_goal",
  description: `Change some parts of the current Goal without resending it. goalVersion is the Goal version you last read; a newer Goal refuses the call with goal_version_conflict. The edits apply in order and save as one next Goal version, with the same effects as update_goal; a refused edit saves none of them and names its 0-based position. edits[].action picks the change:
- set_statement, set_status (draft or active; otherwise a draft stays draft and any other Goal becomes active).
- add_outcome, edit_outcome (new text, same meaning), remove_outcome: an outcome by id. Give a changed meaning a new id with remove_outcome and add_outcome.
- add_item, edit_item, remove_item: an item of list constraints, nonGoals or assumptions, named by its exact current text.
- add_question, edit_question (question and/or blocking), remove_question: an open question by id.
Never call this in parallel with update_goal or edit_goal.`,
  parameters: EditGoal,
} as const;

const updatePlan = {
  name: "update_plan",
  description:
    "Save the whole canonical Plan artifact. Use to make a Plan or rewrite most of it; to change, add, move or remove a few steps use edit_plan, which does not resend the Plan. Each step needs stable unique ids, dependencies, acceptance criteria, applicable workflow rule ids and the ids of the current Goal outcomes it serves. dependsOn may name only other step ids in the same Plan and must not form a cycle, and outcomes may name only ids of the current Goal; otherwise nothing is saved and the refusal lists each issue to fix. A step that keeps its id and its work (every field except outcomes) keeps its progress and evidence; a changed or new step starts over. This creates the next version. Revising a Plan while it runs returns the workflow to shaping.",
  parameters: UpdatePlan,
} as const;

const editPlan = {
  name: "edit_plan",
  description: `Change some steps of the current Plan without resending it. planVersion is the Plan version you last read; a newer Plan refuses the call with plan_version_conflict. The edits apply in order and save as one next version; a refused edit saves none of them. edits[].action picks the change:
- add: a new step with its own unique id, placed at index (0-based) or at the end. Later edits and dependsOn may name its id.
- edit: change the fields given in patch; absent fields keep their value. A done step cannot change.
- move: put a step at index (0-based).
- remove: take a step off the Plan. A done step cannot be removed.
dependsOn and outcomes follow the update_plan rules. Other steps keep their progress and the workflow phase stays as it is. A step added while the Plan runs on a kanban board waits for approval before it runs. Never call this in parallel with update_plan or edit_plan.`,
  parameters: EditPlan,
} as const;

const closePlan = {
  name: "close_plan",
  description:
    "End the current Plan without completing it when its remaining work is no longer needed: another conversation or agent already did it, it was superseded, or the user asked to drop it. A draft, ready, executing or blocked Plan can be closed; a completed or closed one cannot. Done cards keep their evidence; every other card stays as blocked and nothing runs it again, and the Plan leaves the project board. A running workflow returns to shaping. Give the concrete reason. To change the remaining work instead, revise the Plan with update_plan. Never call this in parallel with update_plan or edit_plan.",
  parameters: ClosePlanInput,
} as const;

type WorkflowTool =
  | "startNewGoal"
  | "updateGoal"
  | "editGoal"
  | "updatePlan"
  | "editPlan"
  | "closePlan";

/**
 * What a Plan save answers: the saved version and each step's id, title, status and dependencies.
 * The steps' text is what the call itself sent, and the workflow instructions carry it in full;
 * answering it again made each save tens of kilobytes that every later turn read again.
 */
const savedPlan = ({ phase, plan }: WorkflowState) => ({
  phase,
  plan:
    plan === null
      ? null
      : {
          version: plan.version,
          goalVersion: plan.goalVersion,
          status: plan.status,
          steps: plan.steps.map(({ id, title, status, dependsOn }) => ({
            id,
            title,
            status,
            dependsOn,
          })),
        },
});

/** The workflow tools each phase offers, in the order the model sees them. */
const phaseTools = {
  shaping: ["updateGoal", "editGoal", "updatePlan", "editPlan", "closePlan", "startNewGoal"],
  running: ["updateGoal", "editGoal", "updatePlan", "editPlan", "closePlan"],
  completed: ["startNewGoal"],
  chat: [],
} as const satisfies Record<WorkflowPhase, ReadonlyArray<WorkflowTool>>;

const make = Effect.gen(function* () {
  const events = yield* AppEvents;
  const runtime = yield* Effect.context<Workflows | WorkflowExecution>();

  /** The tools' calls in `sessionId` from the run `runId`. */
  const callsFor = (sessionId: string, runId: string) => {
    // A run's own Plan and progress saves are board changes made by that run, through this call.
    const author = (call: ToolCall) =>
      BoardAuthor.cases.Orchestrator.make({ runId, toolCallId: call.toolCallId });
    const published = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.tap(effect, () => events.publishSession(sessionId, "run-state"));
    /**
     * What a Goal save answers: the saved version and status and the Goal instance. The Goal text is
     * what the call itself sent, and the workflow instructions carry it in full.
     */
    const savedGoal = ({ phase, goal }: WorkflowState) =>
      Effect.flatMap(Workflows, (workflows) =>
        Effect.map(workflows.goalInstanceId(sessionId), (goalInstanceId) => ({
          phase,
          goal: goal === null ? null : { version: goal.version, status: goal.status },
          goalInstanceId,
        })),
      );
    return {
      // A run only asks; the owner applies it once the run completes.
      startNewGoal: (input: StartNewGoal) =>
        Effect.flatMap(Workflows, (workflows) =>
          workflows.requestNewGoal(sessionId, runId, input),
        ).pipe(
          Effect.map((request) => ({
            ...request,
            applied: false as const,
            message:
              "Request accepted; the new Goal is not saved. It will be applied only after this run completes and owner safety checks pass.",
          })),
          published,
          Effect.catchTag("NewGoalTransitionRefused", (failure) =>
            Effect.succeed({
              error: "new_goal_transition_refused" as const,
              reason: failure.reason,
            }),
          ),
          Effect.provideContext(runtime),
        ),

      updateGoal: (input: UpdateGoal) =>
        Effect.flatMap(Workflows, (workflows) => workflows.updateGoal(sessionId, input)).pipe(
          published,
          Effect.flatMap(savedGoal),
          Effect.provideContext(runtime),
        ),

      editGoal: (input: EditGoal) =>
        Effect.flatMap(Workflows, (workflows) => workflows.editGoal(sessionId, input)).pipe(
          published,
          Effect.flatMap(savedGoal),
          Effect.catchTag("GoalEditRefused", ({ reason, edit }) =>
            Effect.succeed({ error: "goal_edit_refused" as const, reason, edit }),
          ),
          Effect.provideContext(runtime),
        ),

      updatePlan: (input: UpdatePlan, call: ToolCall) =>
        Effect.flatMap(Workflows, (workflows) =>
          workflows.updatePlan(sessionId, input, author(call)),
        ).pipe(
          published,
          Effect.map(savedPlan),
          Effect.catchTags({
            PlanDependenciesRejected: (failure) =>
              Effect.succeed({
                error: "plan_dependencies_rejected" as const,
                issues: failure.issues.map(dependencyIssueText),
              }),
            PlanOutcomesRejected: ({ unknown }) =>
              Effect.succeed({
                error: "plan_outcomes_rejected" as const,
                issues: unknown.map(unknownStepOutcomeText),
              }),
          }),
          Effect.provideContext(runtime),
        ),

      editPlan: (input: EditPlan, call: ToolCall) =>
        Effect.flatMap(Workflows, (workflows) =>
          workflows.editPlan(sessionId, input, author(call)),
        ).pipe(
          published,
          Effect.map(savedPlan),
          Effect.catchTags({
            BoardEditRefused: (failure) =>
              Effect.succeed({ error: "plan_edit_refused" as const, reason: failure.reason }),
            PlanDependenciesRejected: (failure) =>
              Effect.succeed({
                error: "plan_dependencies_rejected" as const,
                issues: failure.issues.map(dependencyIssueText),
              }),
            PlanOutcomesRejected: ({ unknown }) =>
              Effect.succeed({
                error: "plan_outcomes_rejected" as const,
                issues: unknown.map(unknownStepOutcomeText),
              }),
          }),
          Effect.provideContext(runtime),
        ),

      closePlan: (input: typeof ClosePlanInput.Type, call: ToolCall) =>
        Effect.flatMap(Workflows, (workflows) =>
          workflows.closePlan(sessionId, input.reason, author(call)),
        ).pipe(
          published,
          Effect.map(savedPlan),
          Effect.catchTag("BoardEditRefused", (failure) =>
            Effect.succeed({ error: "plan_close_refused" as const, reason: failure.reason }),
          ),
          Effect.provideContext(runtime),
        ),
    };
  };

  return {
    /** The tools run on the loop's fiber, so their spans join the run's trace. */
    toolsFor: (sessionId: string, phase: WorkflowPhase, runId: string): RunTool[] => {
      const calls = callsFor(sessionId, runId);
      const tools = {
        startNewGoal: runTool({ ...startNewGoal, handler: calls.startNewGoal }),
        updateGoal: runTool({ ...updateGoal, handler: calls.updateGoal }),
        editGoal: runTool({ ...editGoal, handler: calls.editGoal }),
        updatePlan: runTool({ ...updatePlan, handler: calls.updatePlan }),
        editPlan: runTool({ ...editPlan, handler: calls.editPlan }),
        closePlan: runTool({ ...closePlan, handler: calls.closePlan }),
      } satisfies Record<WorkflowTool, RunTool>;
      return phaseTools[phase].map((tool) => tools[tool]);
    },
  };
});

/** Tools that write only workflow artifacts, never project files. */
export class WorkflowTools extends Context.Service<WorkflowTools, Effect.Success<typeof make>>()(
  "memory-agent/workflow/tools/WorkflowTools",
) {
  static readonly layer = Layer.effect(WorkflowTools, make);
}

const progressStatusOf = (step: PlanStep | undefined) =>
  step === undefined ? "unknown" : stepProgressStatus(step.status);

const compactList = (items: readonly string[], limit = 6) =>
  items.length === 0
    ? "(none)"
    : items
        .slice(0, limit)
        .map((item) => `- ${item}`)
        .join("\n");

const dependencyIssueText = PlanDependencyIssue.match({
  DuplicateStepId: ({ stepId }) => `step id ${stepId} is used more than once`,
  UnknownDependency: ({ stepId, dependsOn }) =>
    `step ${stepId} depends on ${dependsOn}, which is not a step in this Plan`,
  SelfDependency: ({ stepId }) => `step ${stepId} depends on itself`,
  DependencyCycle: ({ cycle }) => `dependency cycle ${cycle.join(" -> ")}`,
});

const scheduleText = (steps: readonly PlanStep[]) => {
  const issues = planDependencyIssues(steps).map(dependencyIssueText);
  const saved =
    issues.length === 0
      ? ""
      : `\nThis saved Plan has dependency issues; unknown and self dependencies are ignored, cycles never become ready. Fix them with update_plan:\n${compactList(issues, issues.length)}`;
  return PlanSchedule.$match(planSchedule(steps), {
    finished: () => saved,
    runnable: ({ ready }) =>
      `\nReady steps (pending with every dependency completed): ${ready.join(", ") || "(none)"}. Continue in_progress steps first, then start a ready step; do not start a step whose dependencies are not completed.${saved}`,
    stalled: ({ blocked, waiting }) =>
      `\nNo remaining step can start: every one is blocked or waits on an unfinished dependency.
${compactList([...blocked.map((id) => `${id} [blocked]`), ...waiting.map(unmetDependencyText)], steps.length)}
Automatic continuation stops in this state. Resolve the blocked step, or revise wrong dependsOn with update_plan.${saved}`,
  });
};

const ruleSource = (rule: ResolvedRules["rules"][number]) =>
  RuleSource.match(rule.source, {
    builtin: ({ name }) => `builtin:${name}`,
    project: ({ path, contentHash }) => `project:${path}#${contentHash.slice(0, 12)}`,
  });

/** An outcome line; on a board it carries the outcome ledger's status and verdict. */
const outcomeLine = (standings: readonly OutcomeStanding[]) => (outcome: GoalOutcome) => {
  const standing = standings.find((candidate) => candidate.outcomeId === outcome.id);
  if (standing === undefined) return `${outcome.id}: ${outcome.text}`;
  const verdict = OutcomeStatus.match(standing.status, {
    Unplanned: () => "",
    InProgress: () => "",
    AwaitingCheck: () => "",
    Met: ({ summary }) => ` (verdict: ${summary})`,
    NotMet: ({ summary }) => ` (verdict: ${summary})`,
  });
  return `${outcome.id} [${outcomeStatusWord(standing.status)}]: ${outcome.text}${verdict}`;
};

/**
 * The workflow's standing instructions. `standings` are the outcome ledger's statuses of a Goal
 * that runs as a kanban board; without them outcomes show no status.
 */
export const workflowInstructions: {
  (
    resolved: ResolvedRules,
    goalInstanceId?: string | null,
    standings?: readonly OutcomeStanding[],
  ): (state: WorkflowState) => string | null;
  (
    state: WorkflowState,
    resolved: ResolvedRules,
    goalInstanceId?: string | null,
    standings?: readonly OutcomeStanding[],
  ): string | null;
} = EffectFunction.dual(
  (args) => Schema.is(WorkflowState)(args[0]),
  (
    state: WorkflowState,
    resolved: ResolvedRules,
    goalInstanceId: string | null = null,
    standings: readonly OutcomeStanding[] = [],
  ) => {
    const applicableRules = resolved.rules
      .map(
        (rule) =>
          `- ${rule.id}@${rule.version} (${rule.priority}; ${ruleSource(rule)}): ${rule.instruction}\n  Evidence: ${rule.requiredEvidence.join("; ") || "(none)"}`,
      )
      .join("\n");
    const common = `Workflow phase: ${state.phase} (${state.mode} mode).
Current Goal instance ID: ${goalInstanceId ?? "(none; legacy/unbound)"}. For start_new_goal, use this exact ID as previousGoalInstanceId (null only if none). This is a snapshot; the owner checks the current ID again at request time.
Goal and Plan are durable artifacts, not substitutes for a conversational answer.
Use only the workflow artifact tools available in this phase, and update an artifact when the user's decisions materially change it.
Never claim an artifact was stored unless its update tool completed.
When an explicit user decision changes saved Goal constraints or non-goals, persist that decision with edit_goal (or update_goal) before proceeding; do not treat an artifact you can update as an external dependency or ask the user to use an unverified Goal editor. Do not ask again for an approval already explicitly given, and never infer permission from a generic resume request. While the Plan runs, a Goal revision returns the workflow to shaping unless a kanban board runs it. Synchronize the Plan with the revised Goal and wait until running it is confirmed.
Applicable workflow rules (reference these ids from Plan steps; do not copy their text into the artifact):
${applicableRules || "(none)"}${resolved.degraded.includes("source") ? "\nOne or more optional structured rule sources were invalid or unreadable and were skipped." : ""}`;

    const goal = isTruthy(state.goal)
      ? `Goal v${state.goal.version} (${state.goal.status}): ${state.goal.statement}
Outcomes (keep each id while the outcome means the same; give a changed meaning a new id${standings.length > 0 ? "; the status is the outcome ledger's: only the verifier's verdict makes one met" : ""}):
${compactList(state.goal.outcomes.map(outcomeLine(standings)), state.goal.outcomes.length)}
Constraints (apply across every continuation; a new turn does not reset limits):
${compactList(state.goal.constraints, state.goal.constraints.length)}
Non-goals:
${compactList(state.goal.nonGoals, state.goal.nonGoals.length)}
Blocking questions:
${compactList(state.goal.openQuestions.filter((question) => question.blocking).map((question) => question.question))}`
      : "Goal: not recorded yet.";

    // Shaping reads as its mode: the planner of a Goal mode Goal, or one the user approves.
    return Match.value(state.phase === "shaping" ? state.mode : state.phase).pipe(
      Match.when("chat", () => null),
      Match.when(
        "completed",
        () =>
          `${common}\nThe Goal and Plan are complete. Do not resume verification or change their completed evidence. Answer follow-up questions conversationally. Start a new Goal only when the user explicitly requests new work.\n\n${goal}`,
      ),
      Match.when(
        "goal",
        () => `${common}
The user delegated an outcome, not merely a request to describe a goal. You are its planner, not its executor: project tools are restricted to read-only investigation. Save a concise active Goal whose outcomes each have a stable id, then save a ready Plan whose cards together serve every outcome (each card names the outcome ids it serves). Goal mode runs it at once: when this run ends the owner approves the Plan and starts its kanban board, where card agents execute the cards and a verifier judges each outcome. Do not implement, verify or record progress yourself. Ask only genuinely blocking questions; record what is uncertain and plan the independent cards first.
${cardCapabilities}

${goal}`,
      ),
      Match.when("plan", () => {
        const plan = isTruthy(state.plan)
          ? `Plan v${state.plan.version} (${state.plan.status}, based on Goal v${state.plan.goalVersion}): ${state.plan.summary}`
          : "Plan: not recorded yet.";
        return `${common}
You are planning, not executing. Project tools are restricted to read-only investigation. If no Goal is recorded, infer the smallest useful Goal from the user's request and save it before the Plan; the user does not need to enter Goal mode first. Produce ordered steps with stable unique ids, dependencies (dependsOn names only other step ids in this Plan, without cycles), acceptance criteria, risks, applicable rule ids and the Goal outcome ids each step serves. When a contradiction or unanswered question arises, record what is uncertain and which decisions depend on it; continue all independent read-only investigation and planning before asking. Narrow questions with evidence and ask only when no useful independent planning remains and the decision truly blocks progress. A non-blocking open question does not by itself require a draft Plan: save a ready Plan when its steps can proceed, and leave the unresolved decision for the step it actually affects. Never assume an answer to a blocking question or mark a Plan ready if the unresolved decision prevents safe execution of its next step. Do not modify files, run skills, delegate work or present investigation as implementation.
Once the Plan is approved, its steps run as cards of a kanban board.
${cardCapabilities}

${goal}

${plan}`;
      }),
      Match.when(
        "running",
        () => `${common}
The current Plan runs on its kanban board: card agents execute the cards in separate worktrees and a verifier judges each Goal outcome; only those verdicts complete the Goal. You do not execute cards, verify them or record their progress yourself. Answer questions about the run from the board and the outcome statuses, without claiming work you did not see done. When the user changes the scope, design or acceptance criteria, revise the Plan with edit_plan, or with update_plan, which returns the workflow to shaping so the revised version can be confirmed before it runs again. Close the Plan with close_plan when its remaining work is no longer needed.
${cardCapabilities}

${goal}

${
  isTruthy(state.plan)
    ? `Approved Plan v${state.plan.version}: ${state.plan.summary}
Current steps:
${state.plan.steps.map((step) => `- ${step.id} [${stepProgressStatus(step.status)}]: ${step.title}${step.status === "done" ? "" : `\n  Description: ${step.description}\n  Depends on: ${step.dependsOn.map((id) => `${id} [${progressStatusOf(state.plan?.steps.find((candidate) => candidate.id === id))}]`).join(", ") || "(none)"}\n  Acceptance criteria:\n${compactList(step.acceptanceCriteria, step.acceptanceCriteria.length)}\n  Rule refs: ${step.ruleRefs.join(", ") || "(none)"}\n  Serves outcomes: ${step.outcomes.join(", ") || "(none)"}\n  Recent evidence (historical evidence is not fresh verification):\n${compactList(step.evidence.slice(-6))}`}`).join("\n")}${scheduleText(state.plan.steps)}`
    : "Approved Plan: missing."
}`,
      ),
      Match.exhaustive,
    );
  },
);
