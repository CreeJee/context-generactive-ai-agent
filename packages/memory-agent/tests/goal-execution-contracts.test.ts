import { describe, expect, it } from "vite-plus/test";
import {
  goalExecutionIdempotencyKey,
  type GoalExecutionIdentity,
} from "../src/workflow/goal-execution-contracts.ts";

const identity = (overrides: Partial<GoalExecutionIdentity> = {}): GoalExecutionIdentity => ({
  owner: { ownerId: "owner-a", generation: "generation-1" },
  sessionId: "session-a",
  runId: "run-a",
  goalInstanceId: "goal-a",
  workflowRevisionId: 7,
  ...overrides,
});

describe("GoalExecution contracts", () => {
  it("derives deterministic, separator-safe IDs while treating owner identity as a fence", () => {
    const base = identity();
    expect(goalExecutionIdempotencyKey(base)).toBe(goalExecutionIdempotencyKey({ ...base }));
    expect(goalExecutionIdempotencyKey(base)).toMatch(/^goal-execution-v1-[0-9a-f]{64}$/);
    expect(
      goalExecutionIdempotencyKey(
        identity({ owner: { ownerId: "owner-a", generation: "generation-2" } }),
      ),
    ).toBe(goalExecutionIdempotencyKey(base));

    expect(
      goalExecutionIdempotencyKey(
        identity({ owner: { ownerId: "owner-b", generation: "generation-1" } }),
      ),
    ).toBe(goalExecutionIdempotencyKey(base));
    const alternatives = [
      identity({ sessionId: "session-b" }),
      identity({ runId: "run-b" }),
      identity({ goalInstanceId: "goal-b" }),
      identity({ workflowRevisionId: 8 }),
    ];
    expect(
      new Set([goalExecutionIdempotencyKey(base), ...alternatives.map(goalExecutionIdempotencyKey)])
        .size,
    ).toBe(5);

    const left = identity({ sessionId: "a:b", runId: "c" });
    const right = identity({ sessionId: "a", runId: "b:c" });
    expect(goalExecutionIdempotencyKey(left)).not.toBe(goalExecutionIdempotencyKey(right));
    expect(goalExecutionIdempotencyKey(base)).not.toContain(base.sessionId);
    expect(goalExecutionIdempotencyKey(base)).not.toContain(base.owner.ownerId);
  });
});
