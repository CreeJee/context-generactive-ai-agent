import { expect, test } from "vite-plus/test";
import { makeOwnerToolGrants } from "../src/agent/owner-tool-grants.ts";
import { makeInMemoryOwnerRpcLedger, makeOwnerRpc } from "../src/agent/owner-rpc.ts";

function observed() {
  const grants = makeOwnerToolGrants();
  grants.observe({ type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "read_file" });
  grants.observe({ type: "TOOL_CALL_ARGS", toolCallId: "c", delta: '{"path":"safe"}' });
  grants.observe({ type: "TOOL_CALL_END", toolCallId: "c" });
  return grants;
}
const legitimate = { toolCallId: "c", name: "read_file", args: { path: "safe" } };

test.each([
  { ...legitimate, name: "write_file" },
  { ...legitimate, toolCallId: "fake" },
  { ...legitimate, args: { path: "different" } },
  { ...legitimate, context: { permission: "approved" } },
])("owner observations and grants reject tampering %j", (attack) => {
  const grants = observed();
  expect(() => grants.observed(attack)).toThrow();
  expect(() => grants.approve(attack, legitimate.args)).toThrow();
  const invocation = grants.observed(legitimate);
  grants.approve(invocation, legitimate.args);
  expect(grants.validate(attack)).toBe(false);
  expect(() => grants.consume(attack)).toThrow();
  expect(grants.validate(legitimate)).toBe(true);
  expect(grants.consume(legitimate)).toEqual(legitimate);
  expect(grants.validate(legitimate)).toBe(false);
});

test.each(["prefetch", "delivery"])(
  "implementation grant is single-use across %s order",
  (order) => {
    const grants = observed();
    expect(() => grants.start(legitimate)).toThrow();
    grants.approve(grants.observed(legitimate), legitimate.args);
    if (order === "prefetch") {
      expect(grants.start(legitimate)).toEqual(legitimate);
      expect(grants.consume(legitimate)).toEqual(legitimate);
    } else {
      expect(grants.consume(legitimate)).toEqual(legitimate);
      expect(grants.start(legitimate)).toEqual(legitimate);
    }
    expect(() => grants.start(legitimate)).toThrow();
    expect(() => grants.consume(legitimate)).toThrow();
  },
);

test("unobserved, unfinished and duplicate calls never become grants", () => {
  const grants = makeOwnerToolGrants();
  expect(() => grants.observed(legitimate)).toThrow();
  grants.observe({ type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "read_file" });
  expect(() => grants.observed(legitimate)).toThrow();
  expect(() =>
    grants.observe({ type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "read_file" }),
  ).toThrow();
});

test("malformed invocation never reserves an uncertain side effect; legitimate next operation succeeds", async () => {
  const grants = observed();
  grants.approve(grants.observed(legitimate), legitimate.args);
  const inner = makeInMemoryOwnerRpcLedger();
  let reservations = 0;
  let effects = 0;
  const endpoint = makeOwnerRpc({
    permits: () => true,
    ledger: {
      reserve(...args) {
        reservations++;
        return inner.reserve(...args);
      },
      settle: (...args) => inner.settle(...args),
    },
    handlers: {
      tool: {
        sideEffect: true,
        authorize: (input) => grants.validate(input),
        execute: async (input) => {
          grants.consume(input);
          effects++;
          return "read result";
        },
      },
    },
  });
  const capability = {
    runId: "r",
    sessionId: "s",
    goalInstanceId: "g",
    goalVersion: 1,
    planVersion: null,
    workflowRevisionId: 1,
    generation: "one",
    token: "secret",
  };
  expect(
    await endpoint({
      type: "owner-rpc-request",
      operationId: 1,
      capability,
      operation: "tool",
      input: { ...legitimate, name: "write_file" },
    }),
  ).toMatchObject({ type: "rejected", reason: "invalid_operation" });
  expect(reservations).toBe(0);
  expect(effects).toBe(0);
  expect(
    await endpoint({
      type: "owner-rpc-request",
      operationId: 2,
      capability,
      operation: "tool",
      input: legitimate,
    }),
  ).toMatchObject({ type: "succeeded" });
  expect(reservations).toBe(1);
  expect(effects).toBe(1);
});
