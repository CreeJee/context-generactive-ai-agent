import { Schema, Struct } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  GoalExecutionError,
  GoalExecutionErrorReason,
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
    const payload = GoalExecutionPayload.make({ identity: identity() });
    expect(Schema.is(GoalExecutionPayload)(payload)).toBe(true);
    const success = GoalExecutionSuccess.make({
      executionId: "a".repeat(32),
      runId: "run-a",
      outcome: "completed",
    });
    expect(Schema.is(GoalExecutionSuccess)(success)).toBe(true);
    expect(
      Schema.is(GoalExecutionError)(
        GoalExecutionError.make({
          executionId: "a".repeat(32),
          reason: GoalExecutionErrorReason.cases.SideEffectUncertain.make({
            operationId: "tool-1",
            state: "pending",
          }),
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
      expect(Schema.is(GoalExecutionPayload)({ ...payload, identity: value })).toBe(false);
    }
    expect(
      Schema.is(GoalExecutionSuccess)({ ...success, executionId: "not-a-goal-execution-id" }),
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
    const { Succeeded, Pending, Uncertain } = GoalExecutionSideEffectState.cases;
    const isState = Schema.is(GoalExecutionSideEffectState);
    const succeeded = Succeeded.make({
      operationId: "operation-1",
      replay: "reuse_receipt",
      receipt: { providerReceiptId: "receipt-1" },
    });
    const pending = Pending.make({ operationId: "operation-1", disposition: "stop" });
    const uncertain = Uncertain.make({ operationId: "operation-1", disposition: "stop" });
    expect(isState(succeeded)).toBe(true);
    expect(isState(pending)).toBe(true);
    expect(isState(uncertain)).toBe(true);

    expect(isState({ ...pending, disposition: "retry" })).toBe(false);
    expect(isState(Struct.omit(succeeded, ["receipt"]))).toBe(false);
    expect(
      isState({
        ...Struct.omit(uncertain, ["disposition"]),
        replay: "reuse_receipt",
        receipt: { providerReceiptId: "receipt-1" },
      }),
    ).toBe(false);
  });
});
