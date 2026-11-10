import { describe, expect, test } from "vite-plus/test";
import { workflowActions } from "./actions.ts";
import { cardCapabilities } from "./card-capabilities.ts";
import { OutcomeStatus } from "./outcome-ledger.ts";
import { builtInWorkflowRules, rulePhases } from "./rules.ts";
import { workflowInstructions } from "./tools.ts";
import type { WorkflowMode, WorkflowPhase, WorkflowState } from "./workflow.ts";

const state = (phase: WorkflowPhase, mode: WorkflowMode = "plan"): WorkflowState => ({
  phase,
  mode,
  goal: null,
  plan: null,
  ledger: [],
});

const resolved = (phase: WorkflowPhase) => ({
  rules: builtInWorkflowRules.filter(
    (rule) =>
      rule.phases.some((rulePhase) => rulePhases[phase].some((read) => read === rulePhase)) &&
      rule.priority === "required",
  ),
  degraded: [],
});

describe("workflowInstructions", () => {
  test("tells every planner what card agents and verifiers can do, and no other phase", () => {
    const planner = (phase: WorkflowPhase, mode: WorkflowMode) =>
      workflowInstructions(state(phase, mode), resolved(phase));
    for (const prompt of [
      planner("shaping", "goal"),
      planner("shaping", "plan"),
      planner("running", "plan"),
    ]) {
      expect(prompt).toContain(cardCapabilities);
    }
    expect(planner("completed", "plan")).not.toContain(cardCapabilities);
  });
  test("provides the owner-read Goal instance ID instead of inferring it from Goal version", () => {
    const prompt = workflowInstructions(state("completed"), resolved("completed"), "owner-id-123");
    expect(prompt).toContain("Current Goal instance ID: owner-id-123");
    expect(prompt).toContain("use this exact ID as previousGoalInstanceId");
    expect(workflowInstructions(state("shaping", "goal"), resolved("shaping"), null)).toContain(
      "Current Goal instance ID: (none; legacy/unbound)",
    );
  });
  test("lists the Goal's blocking open questions in the Plan prompt", () => {
    const prompt = workflowInstructions(
      {
        ...state("shaping"),
        goal: {
          version: 1,
          statement: "Resolve two independent changes",
          outcomes: [{ id: "O1", text: "Both changes planned" }],
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
      resolved("shaping"),
    );

    expect(prompt).toContain("Which approach for the second change?");
  });
  test("shows a board's outcomes with the ledger's status and verdict, every one of them", () => {
    const outcomes = ["O1", "O2", "O3", "O4", "O5", "O6", "O7"].map((id) => ({
      id,
      text: `Outcome ${id}`,
    }));
    const goal = {
      version: 1,
      statement: "Ship the feature",
      outcomes,
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active" as const,
      evidence: [],
      verification: {
        status: "not_run" as const,
        summary: "",
        evidence: [],
        recoveryPhase: null,
        updatedAt: null,
      },
      updatedAt: "2026-11-09T00:00:00.000Z",
    };
    const prompt = workflowInstructions({ ...state("running"), goal }, resolved("running"), "g", [
      {
        outcomeId: "O1",
        outcomeText: "Outcome O1",
        status: OutcomeStatus.cases.Met.make({ summary: "search returns results" }),
      },
      {
        outcomeId: "O2",
        outcomeText: "Outcome O2",
        status: OutcomeStatus.cases.InProgress.make({ pending: ["c2"] }),
      },
    ]);
    expect(prompt).toContain("O1 [met]: Outcome O1 (verdict: search returns results)");
    expect(prompt).toContain("O2 [in_progress]: Outcome O2");
    // Outcomes the ledger does not name show without a status; none is cut from the list.
    expect(prompt).toContain("- O7: Outcome O7");
  });

  test("a recorded non-blocking question does not prevent a ready Plan from executing", () => {
    const template = state("shaping");
    const goal: NonNullable<WorkflowState["goal"]> = {
      version: 1,
      statement: "Investigate",
      outcomes: [{ id: "O1", text: "Evidence" }],
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
    expect(workflowActions(ready).moves.run).toEqual({ allowed: true, intent: "start" });
    expect(workflowInstructions(ready, resolved("shaping"))).toContain(
      "non-blocking open question",
    );
    expect(workflowActions({ ...ready, plan: { ...plan, status: "draft" } }).moves.run).toEqual({
      allowed: false,
      reason: "plan_not_ready",
    });
  });

  test("shows a running Plan's unfinished card and the constraints that outlive a turn", () => {
    const verification = {
      status: "not_run" as const,
      summary: "",
      evidence: [],
      recoveryPhase: null,
      updatedAt: null,
    };
    const current: WorkflowState = {
      ...state("running"),
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
            outcomes: [],
            status: "in_progress",
            evidence: Array.from({ length: 8 }, (_, i) => `receipt-${i}`),
          },
        ],
      },
    };
    const prompt = workflowInstructions(current, resolved("running"));
    [
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
      "You do not execute cards, verify them or record their progress yourself.",
    ].forEach((text) => {
      expect(prompt).toContain(text);
    });
    expect(prompt).not.toContain("receipt-0");
    expect(current.plan?.steps[0]?.status).toBe("in_progress");
  });
});
