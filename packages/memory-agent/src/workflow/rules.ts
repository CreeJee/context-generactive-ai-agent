import { Array as EffectArray, Function as EffectFunction, Schema } from "effect";
import type { WorkflowPhase } from "./workflow.ts";

/**
 * The work a rule guides: defining the Goal, planning, executing cards or verifying them. Rule
 * files name these, so they stay apart from the workflow's phases.
 */
export const RulePhase = Schema.Literals(["goal", "plan", "execute", "verify"]);
export type RulePhase = typeof RulePhase.Type;

/**
 * The rules a conversation in each phase reads: shaping defines the Goal and plans; while the Plan
 * runs the conversation only revises it, and card agents read no rules.
 */
export const rulePhases = {
  chat: [],
  shaping: ["goal", "plan"],
  running: ["plan"],
  completed: [],
} as const satisfies Record<WorkflowPhase, ReadonlyArray<RulePhase>>;

export const RuleSource = Schema.TaggedUnion({
  builtin: { name: Schema.String },
  project: { path: Schema.String, contentHash: Schema.String },
});
export type RuleSource = typeof RuleSource.Type;

export const WorkflowRule = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))),
  version: Schema.Int,
  title: Schema.NonEmptyString,
  phases: Schema.Array(RulePhase),
  priority: Schema.Literals(["required", "recommended"]),
  instruction: Schema.NonEmptyString,
  requiredEvidence: Schema.Array(Schema.String),
  source: RuleSource,
});
export type WorkflowRule = typeof WorkflowRule.Type;

export interface ResolvedRules {
  readonly rules: readonly WorkflowRule[];
  /** `source`: the project's rule file was invalid or unreadable and was skipped. */
  readonly degraded: readonly "source"[];
}

const builtInRuleInputs: readonly Omit<WorkflowRule, "source">[] = [
  {
    id: "workflow.goal.definition",
    version: 1,
    title: "Define outcomes before implementation",
    phases: ["goal"],
    priority: "required",
    instruction:
      "Record the problem, observable outcomes, constraints, non-goals, assumptions and blocking questions. Do not turn implementation guesses into requirements.",
    requiredEvidence: ["A saved Goal artifact with no unanswered blocking question before acting"],
  },
  {
    id: "workflow.plan.readonly",
    version: 1,
    title: "Planning is read-only",
    phases: ["plan"],
    priority: "required",
    instruction:
      "Investigate without changing project files, saving or running code skills, delegating, or using write-capable external tools.",
    requiredEvidence: ["No project mutation was performed during Plan"],
  },
  {
    id: "workflow.plan.actionable",
    version: 1,
    title: "Plans have executable steps",
    phases: ["plan"],
    priority: "required",
    instruction:
      "Give steps stable ids, explicit dependencies and observable acceptance criteria. Attach the ids of applicable rules rather than copying their full text.",
    requiredEvidence: ["A saved Plan artifact tied to the current Goal version"],
  },
  {
    id: "workflow.plan.blockers",
    version: 1,
    title: "Defer questions until independent planning is exhausted",
    phases: ["plan"],
    priority: "required",
    instruction:
      "Record unresolved decisions and their dependencies, complete independent read-only investigation and planning first, then ask only about decisions that actually block further progress. Non-blocking questions alone do not prevent a ready Plan; never guess an answer needed for safe execution.",
    requiredEvidence: [
      "Independent investigation and steps were completed before a blocker was raised",
    ],
  },
  {
    id: "workflow.execute.approved",
    version: 1,
    title: "Execute only an approved current Plan",
    phases: ["execute"],
    priority: "required",
    instruction:
      "Execute only the approved Plan tied to the current Goal. Work one active step at a time and do not claim completion from intention.",
    requiredEvidence: ["The active step and its verification result"],
  },
  {
    id: "workflow.verify.evidence",
    version: 1,
    title: "Completion requires evidence",
    phases: ["verify"],
    priority: "required",
    instruction:
      "Check every applicable acceptance criterion and rule. Report failures explicitly; do not silently repair or waive them.",
    requiredEvidence: ["Evidence or an explicit failure for every checked criterion"],
  },
  {
    id: "workflow.plan.migration",
    version: 1,
    title: "Plan reversible migrations",
    phases: ["plan", "execute", "verify"],
    priority: "recommended",
    instruction:
      "For schema or data changes, specify compatibility order, rollback behavior, backfill strategy and validation.",
    requiredEvidence: ["Migration compatibility and rollback were considered"],
  },
  {
    id: "workflow.plan.testing",
    version: 1,
    title: "Plan verification with the change",
    phases: ["plan", "execute", "verify"],
    priority: "recommended",
    instruction:
      "Name the smallest checks that prove the step, then include broader regression checks appropriate to the affected area.",
    requiredEvidence: ["Commands or observations and their actual results"],
  },
  {
    id: "workflow.plan.documentation",
    version: 1,
    title: "Research authoritative interfaces",
    phases: ["plan"],
    priority: "recommended",
    instruction:
      "When behavior depends on an external API or library version, research the authoritative documentation and record the relevant constraint in the Plan.",
    requiredEvidence: ["The authoritative source or installed implementation was checked"],
  },
];

export const builtInWorkflowRules: readonly WorkflowRule[] = builtInRuleInputs.map((rule) => ({
  ...rule,
  source: RuleSource.cases.builtin.make({ name: rule.id }),
}));

/**
 * The rules a conversation in `phases` reads: every built-in and project rule of those phases,
 * required ones first. A project rule with a built-in id is ignored. The recommended rules are few
 * and short, so all of them go to the model, which judges which apply.
 */
export const workflowRulesFor: {
  (
    phases: ReadonlyArray<RulePhase>,
  ): (projectRules: readonly WorkflowRule[]) => readonly WorkflowRule[];
  (
    projectRules: readonly WorkflowRule[],
    phases: ReadonlyArray<RulePhase>,
  ): readonly WorkflowRule[];
} = EffectFunction.dual(2, workflowRulesForBody);
function workflowRulesForBody(
  projectRules: readonly WorkflowRule[],
  phases: ReadonlyArray<RulePhase>,
): readonly WorkflowRule[] {
  const applicable = EffectArray.dedupeWith(
    [...builtInWorkflowRules, ...projectRules],
    (left, right) => left.id === right.id,
  ).filter((rule) => rule.phases.some((phase) => phases.includes(phase)));
  return [
    ...applicable.filter((rule) => rule.priority === "required"),
    ...applicable.filter((rule) => rule.priority === "recommended"),
  ];
}
