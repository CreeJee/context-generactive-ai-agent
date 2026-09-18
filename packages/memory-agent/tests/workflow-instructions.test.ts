import { describe, expect, test } from "vite-plus/test";
import { builtInWorkflowRules } from "../src/workflow/rules.ts";
import { workflowInstructions } from "../src/workflow/tools.ts";
import type { WorkflowPhase, WorkflowState } from "../src/workflow/workflow.ts";

const state = (phase: WorkflowPhase): WorkflowState => ({
  phase,
  goal: null,
  plan: null,
  ledger: [],
});

const resolved = (phase: WorkflowPhase) => ({
  rules: builtInWorkflowRules.filter(
    (rule) => rule.phases.includes(phase) && rule.priority === "required",
  ),
  degraded: [],
});

describe("workflowInstructions", () => {
  test("treats Goal as autonomous outcome delegation rather than a planning gate", () => {
    const prompt = workflowInstructions(state("goal"), resolved("goal"));

    expect(prompt).toContain("autonomously investigate, implement and verify");
    expect(prompt).toContain("without requiring a Plan artifact");
    expect(prompt).not.toContain("Do not create an implementation Plan or modify project files");
  });

  test("lets Plan infer an internal Goal while preserving its read-only boundary", () => {
    const prompt = workflowInstructions(state("plan"), resolved("plan"));

    expect(prompt).toContain("If no Goal is recorded");
    expect(prompt).toContain("the user does not need to enter Goal mode first");
    expect(prompt).toContain("restricted to read-only investigation");
  });

  test("distinguishes implementation failure from invalid verification premises", () => {
    const prompt = workflowInstructions(state("verify"), resolved("verify"));

    expect(prompt).toContain("invalid_hypothesis");
    expect(prompt).toContain("invalid_criterion");
    expect(prompt).toContain("inconclusive");
    expect(prompt).toContain("blocked only for a confirmed external dependency");
    expect(prompt).toContain("Do not invent settings");
  });
});
