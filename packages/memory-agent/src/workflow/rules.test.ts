import { Array as EffectArray } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { builtInWorkflowRules, RuleSource, workflowRulesFor, type WorkflowRule } from "./rules.ts";

const projectRule = (rule: Partial<WorkflowRule>): WorkflowRule => ({
  id: "project.fixtures",
  version: 1,
  title: "Seed fixtures first",
  phases: ["plan"],
  priority: "recommended",
  instruction: "Seed fixtures before writing tests.",
  requiredEvidence: [],
  source: RuleSource.cases.project.make({ path: ".agents/workflow-rules.json", contentHash: "x" }),
  ...rule,
});

describe("workflowRulesFor", () => {
  it("gives every rule of the phases, required ones first", () => {
    const ids = workflowRulesFor([projectRule({})], ["plan"]).map((rule) => rule.id);
    expect(ids).toEqual([
      "workflow.plan.readonly",
      "workflow.plan.actionable",
      "workflow.plan.blockers",
      "workflow.plan.migration",
      "workflow.plan.testing",
      "workflow.plan.documentation",
      "project.fixtures",
    ]);
  });

  it("leaves out rules of other phases", () => {
    const ids = workflowRulesFor([projectRule({})], ["goal"]).map((rule) => rule.id);
    expect(ids).toEqual(["workflow.goal.definition"]);
    expect(workflowRulesFor([projectRule({})], [])).toEqual([]);
  });

  it("ignores a project rule with a built-in id", () => {
    const rules = workflowRulesFor(
      [projectRule({ id: "workflow.plan.testing", instruction: "Skip the tests." })],
      ["plan"],
    );
    expect(rules.find((rule) => rule.id === "workflow.plan.testing")?.instruction).not.toBe(
      "Skip the tests.",
    );
  });

  it("has unique versioned ids", () => {
    const identities = builtInWorkflowRules.map((rule) => `${rule.id}@${rule.version}`);
    expect(EffectArray.dedupe(identities).length).toBe(identities.length);
  });
});
