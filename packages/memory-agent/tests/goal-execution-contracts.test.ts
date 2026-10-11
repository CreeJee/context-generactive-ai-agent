import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  GoalExecutionError,
  GoalExecutionPayload,
  GoalExecutionSideEffectState,
  GoalExecutionSuccess,
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
  it("accepts complete payload/success/error values and rejects malformed identities", () => {
    expect(
      Schema.is(GoalExecutionPayload)({
        _tag: "GoalExecutionPayload",
        identity: identity(),
      }),
    ).toBe(true);
    expect(
      Schema.is(GoalExecutionSuccess)({
        _tag: "GoalExecutionSuccess",
        executionId: "a".repeat(32),
        runId: "run-a",
        outcome: "completed",
      }),
    ).toBe(true);
    expect(
      Schema.is(GoalExecutionError)(
        GoalExecutionError.make({
          executionId: "a".repeat(32),
          reason: { _tag: "SideEffectUncertain", operationId: "tool-1", state: "pending" },
        }),
      ),
    ).toBe(true);

    const malformed = [
      { ...identity(), sessionId: "" },
      { ...identity(), sessionId: "   " },
      { ...identity(), runId: "" },
      { ...identity(), goalInstanceId: "" },
      { ...identity(), workflowRevisionId: -1 },
      { ...identity(), workflowRevisionId: 1.5 },
      { ...identity(), owner: { ownerId: "", generation: "generation-1" } },
      { ...identity(), owner: { ownerId: "owner-a", generation: "" } },
    ];
    for (const value of malformed) {
      expect(
        Schema.is(GoalExecutionPayload)({ _tag: "GoalExecutionPayload", identity: value }),
      ).toBe(false);
    }
    expect(
      Schema.is(GoalExecutionSuccess)({
        _tag: "GoalExecutionSuccess",
        executionId: "not-a-goal-execution-id",
        runId: "run-a",
        outcome: "completed",
      }),
    ).toBe(false);
  });

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

  it("replays only succeeded receipts and stops pending or uncertain operations", () => {
    expect(
      Schema.is(GoalExecutionSideEffectState)({
        _tag: "Succeeded",
        operationId: "operation-1",
        replay: "reuse_receipt",
        receipt: { providerReceiptId: "receipt-1" },
      }),
    ).toBe(true);
    expect(
      Schema.is(GoalExecutionSideEffectState)({
        _tag: "Pending",
        operationId: "operation-1",
        disposition: "stop",
      }),
    ).toBe(true);
    expect(
      Schema.is(GoalExecutionSideEffectState)({
        _tag: "Uncertain",
        operationId: "operation-1",
        disposition: "stop",
      }),
    ).toBe(true);

    expect(
      Schema.is(GoalExecutionSideEffectState)({
        _tag: "Pending",
        operationId: "operation-1",
        disposition: "retry",
      }),
    ).toBe(false);
    expect(
      Schema.is(GoalExecutionSideEffectState)({
        _tag: "Succeeded",
        operationId: "operation-1",
        replay: "reuse_receipt",
      }),
    ).toBe(false);
    expect(
      Schema.is(GoalExecutionSideEffectState)({
        _tag: "Uncertain",
        operationId: "operation-1",
        replay: "reuse_receipt",
        receipt: { providerReceiptId: "receipt-1" },
      }),
    ).toBe(false);
  });
});
