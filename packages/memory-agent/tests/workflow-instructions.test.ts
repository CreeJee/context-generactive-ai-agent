import { describe, expect, test } from "vite-plus/test";
import { workflowActions } from "../src/workflow/actions.ts";
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
  test("provides the owner-read Goal instance ID instead of inferring it from Goal version", () => {
    const prompt = workflowInstructions(state("completed"), resolved("completed"), "owner-id-123");
    expect(prompt).toContain("Current Goal instance ID: owner-id-123");
    expect(prompt).toContain("use this exact ID as previousGoalInstanceId");
    expect(workflowInstructions(state("goal"), resolved("goal"), null)).toContain(
      "Current Goal instance ID: (none; legacy/unbound)",
    );
  });
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

  test("continues independent planning before narrowing a genuinely blocking question", () => {
    const prompt = workflowInstructions(
      {
        ...state("plan"),
        goal: {
          version: 1,
          statement: "Resolve two independent changes",
          outcomes: ["Both changes planned"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [
            { id: "q1", question: "Which approach for the second change?", blocking: true },
          ],
          status: "active",
          evidence: [],
          verification: {
            status: "not_run",
            summary: "",
            evidence: [],
            recoveryPhase: null,
            updatedAt: null,
          },
          updatedAt: "2026-09-30T00:00:00.000Z",
        },
      },
      resolved("plan"),
    );

    expect(prompt).toContain("Which approach for the second change?");
    expect(prompt).toContain(
      "continue all independent read-only investigation and planning before asking",
    );
    expect(prompt).toContain("ask only when no useful independent planning remains");
    expect(prompt).toContain(
      "A non-blocking open question does not by itself require a draft Plan",
    );
    expect(prompt).toContain("never guess an answer needed for safe execution");
    expect(prompt).toContain("Do not modify files, run commands, delegate work");
    expect(resolved("plan").rules.some((rule) => rule.id === "workflow.plan.blockers")).toBe(true);
  });

  test("a recorded non-blocking question does not prevent a ready Plan from executing", () => {
    const template = state("plan");
    const goal: NonNullable<WorkflowState["goal"]> = {
      version: 1,
      statement: "Investigate",
      outcomes: ["Evidence"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [{ id: "q1", question: "Later choice?", blocking: false }],
      status: "active",
      evidence: [],
      verification: {
        status: "not_run",
        summary: "",
        evidence: [],
        recoveryPhase: null,
        updatedAt: null,
      },
      updatedAt: "2026-09-30T00:00:00.000Z",
    };
    const plan: NonNullable<WorkflowState["plan"]> = {
      version: 1,
      goalVersion: 1,
      summary: "Independent research first",
      steps: [],
      risks: [],
      openQuestions: ["Later choice?"],
      status: "ready",
      evidence: [],
      verification: goal.verification,
      updatedAt: goal.updatedAt,
    };
    const ready = { ...template, goal, plan };
    expect(workflowActions(ready).phases.execute).toEqual({ allowed: true, intent: "start" });
    expect(workflowInstructions(ready, resolved("plan"))).toContain("non-blocking open question");
    expect(
      workflowActions({ ...ready, plan: { ...plan, status: "draft" } }).phases.execute,
    ).toEqual({ allowed: false, reason: "plan_not_ready" });
  });

  test("rehydrates an unfinished approved step and preserves cross-turn constraints", () => {
    const verification = {
      status: "not_run" as const,
      summary: "",
      evidence: [],
      recoveryPhase: null,
      updatedAt: null,
    };
    const current: WorkflowState = {
      ...state("execute"),
      goal: {
        version: 2,
        statement: "Long task",
        outcomes: [],
        constraints: ["Stop after 10 minutes without edits", "Stop after two failed approaches"],
        nonGoals: ["Do not replace the live runtime"],
        assumptions: [],
        openQuestions: [],
        status: "active",
        evidence: [],
        verification,
        updatedAt: "2026-10-02",
      },
      plan: {
        version: 11,
        goalVersion: 2,
        summary: "Existing approved work",
        status: "executing",
        risks: [],
        openQuestions: [],
        evidence: [],
        verification,
        updatedAt: "2026-10-02",
        steps: [
          {
            id: "P03B2",
            title: "Integration",
            description: "Continue owner integration",
            dependsOn: ["P03B1"],
            acceptanceCriteria: ["Persisted replay passes"],
            ruleRefs: ["workflow.execute.approved@1"],
            status: "in_progress",
            evidence: Array.from({ length: 8 }, (_, i) => `receipt-${i}`),
          },
        ],
      },
    };
    const prompt = workflowInstructions(current, resolved("execute"));
    for (const text of [
      "Approved Plan v11",
      "P03B2 [in_progress]",
      "Continue owner integration",
      "Depends on: P03B1",
      "Persisted replay passes",
      "receipt-7",
      "Stop after 10 minutes without edits",
      "Stop after two failed approaches",
      "Do not replace the live runtime",
      "a new turn does not reset limits",
      "rather than merely listing remaining tasks",
      "is not by itself execution intent or new approval",
      "pending permissions or a confirmed blocker",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain("receipt-0");
    expect(current.plan?.steps[0]?.status).toBe("in_progress");
  });

  test("allows material Plan revisions during Execute and requires reconfirmation", () => {
    const prompt = workflowInstructions(state("execute"), resolved("execute"));

    expect(prompt).toContain("revise the Plan with update_plan");
    expect(prompt).toContain("returns the workflow to Plan");
    expect(prompt).toContain("confirmed before execution resumes");
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
