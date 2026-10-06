// Test/benchmark SDK boundary uses native Promise callbacks, I/O fixtures and synchronous codec assertions.
// @effect-diagnostics asyncFunction:off
import { ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { RelayedApprovals, type RelayedRequest } from "../src/approvals/relayed.ts";

const request: RelayedRequest = {
  requester: { kind: "subagent", subagentId: "child", name: null },
  toolName: "write_file",
  argumentsJson: "{}",
  reason: "Approve this write",
  askedBy: "every_call",
};

test("correlates concurrent answers by request and session, and accepts each once", async () => {
  const runtime = ManagedRuntime.make(RelayedApprovals.layer);
  try {
    const relay = await runtime.runPromise(RelayedApprovals);
    const signal = new AbortController().signal;
    const first = relay.ask("s", request, signal);
    const second = relay.ask("s", request, signal);
    const [a, b] = relay.pending("s");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(relay.answer("other", b!.id, true)).toBe(false);
    expect(relay.answer("s", b!.id, true)).toBe(true);
    expect(relay.answer("s", b!.id, false)).toBe(false);
    expect(relay.answer("s", a!.id, false)).toBe(true);
    expect(await Promise.all([first, second])).toEqual([false, true]);
    expect(relay.pending("s")).toEqual([]);
  } finally {
    await runtime.dispose();
  }
});

test("cancellation removes only its waiter and rejects a late approval", async () => {
  const runtime = ManagedRuntime.make(RelayedApprovals.layer);
  try {
    const relay = await runtime.runPromise(RelayedApprovals);
    const controller = new AbortController();
    const cancelled = relay.ask("s", request, controller.signal);
    const survivor = relay.ask("s", request, new AbortController().signal);
    const [a, b] = relay.pending("s");
    controller.abort();
    expect(await cancelled).toBe(false);
    expect(relay.pending("s").map((entry) => entry.id)).toEqual([b!.id]);
    expect(relay.answer("s", a!.id, true)).toBe(false);
    expect(relay.answer("s", b!.id, true)).toBe(true);
    expect(await survivor).toBe(true);
  } finally {
    await runtime.dispose();
  }
});

test("scope disposal resolves all waits as denied and prevents new waits", async () => {
  const runtime = ManagedRuntime.make(RelayedApprovals.layer);
  const relay = await runtime.runPromise(RelayedApprovals);
  const first = relay.ask("s", request, new AbortController().signal);
  const second = relay.ask("other", request, new AbortController().signal);
  await runtime.dispose();
  expect(await Promise.all([first, second])).toEqual([false, false]);
  expect(relay.pending("s")).toEqual([]);
  expect(await relay.ask("s", request, new AbortController().signal)).toBe(false);
});
