import type { SessionRunState } from "memory-agent/definitions";
import type { WorkflowState } from "./api";

/** Deliberately supplied server decisions: UI tests must not recalculate domain policy. */
export const allowedWorkflowActions: SessionRunState["actions"] = {
  phases: {
    chat: { allowed: true },
    goal: { allowed: true },
    plan: { allowed: true },
    execute: { allowed: true, intent: "start" },
    verify: { allowed: true },
  },
  controls: { pause: { allowed: true }, resume: { allowed: true }, stop: { allowed: true } },
};

export const workflowFixture: WorkflowState = {
  phase: "plan",
  goal: {
    version: 2,
    statement: "Repair workflow",
    status: "active",
    outcomes: [],
    constraints: [],
    nonGoals: [],
    assumptions: [],
    openQuestions: [],
    evidence: [],
    updatedAt: "2026-09-24",
    verification: {
      status: "not_run",
      summary: "",
      evidence: [],
      recoveryPhase: null,
      updatedAt: null,
    },
  },
  plan: {
    version: 4,
    goalVersion: 2,
    summary: "Test the policy",
    status: "executing",
    steps: [],
    risks: [],
    openQuestions: [],
    evidence: [],
    updatedAt: "2026-09-24",
    verification: {
      status: "not_run",
      summary: "",
      evidence: [],
      recoveryPhase: null,
      updatedAt: null,
    },
  },
  ledger: [],
};
