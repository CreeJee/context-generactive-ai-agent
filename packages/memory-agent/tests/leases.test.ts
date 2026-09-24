import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { sessionHolderHeader } from "../src/sessions/lease-state.ts";
import { makeLeases } from "../src/sessions/leases.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const Lease = Schema.Union([
  Schema.Struct({ state: Schema.Literal("mine") }),
  Schema.Struct({ state: Schema.Literal("other"), since: Schema.Number }),
  Schema.Struct({ state: Schema.Literal("free") }),
]);
const StatusLease = Schema.Struct({ lease: Lease });

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("session leases", () => {
  test("one page holds a session until it lets go or stops renewing", () => {
    let clock = 1_000;
    const leases = makeLeases(30_000, () => clock);

    expect(leases.claim("s", "tab-a")).toEqual({ claimed: true });
    expect(leases.view("s", "tab-a")).toEqual({ state: "mine" });
    expect(leases.view("s", "tab-b")).toEqual({ state: "other", since: 1_000 });
    // The second page asking loses and stays read-only.
    expect(leases.claim("s", "tab-b")).toEqual({ claimed: false, heldSince: 1_000 });
    expect(leases.permits("s", "tab-b")).toBe(false);
    expect(leases.permits("s", null)).toBe(false);

    // Renewing keeps it; a page that stops renewing loses it, but nobody takes it automatically.
    clock += 20_000;
    leases.claim("s", "tab-a");
    clock += 20_000;
    expect(leases.view("s", "tab-b").state).toBe("other");
    clock += 30_000;
    expect(leases.view("s", "tab-b")).toEqual({ state: "free" });
    expect(leases.claim("s", "tab-b")).toEqual({ claimed: true });
    expect(leases.view("s", "tab-a").state).toBe("other");

    // Only the holder can release.
    leases.release("s", "tab-a");
    expect(leases.view("s", "tab-b")).toEqual({ state: "mine" });
    leases.release("s", "tab-b");
    expect(leases.view("s", "tab-a")).toEqual({ state: "free" });
  });

  test("expired leases are reclaimed even when their sessions are not requested again", () => {
    let clock = 0;
    const leases = makeLeases(100, () => clock);
    leases.claim("old", "tab-a");
    clock = 50;
    leases.claim("fresh", "tab-b");
    clock = 110;
    expect(leases.sweepExpired()).toBe(1);
    expect(leases.view("old", "tab-a")).toEqual({ state: "free" });
    expect(leases.view("fresh", "tab-b")).toEqual({ state: "mine" });
  });

  test("a page that does not hold the session can read it but not send, approve or cancel", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, session } = context;
    await context.provider!.select(runtime);
    const agent = await runtime.runPromise(AgentChat);
    const leaseOf = async (holder: string) =>
      Schema.decodeUnknownSync(StatusLease)(
        await (await runtime.runPromise(agent.status(session.id, holder))).json(),
      ).lease;

    await runtime.runPromise(agent.lease(session.id, "tab-a", "claim"));
    // A second tab asks too and is refused.
    const refused = await runtime.runPromise(agent.lease(session.id, "tab-b", "claim"));
    expect(Schema.decodeUnknownSync(Lease)(await refused.json()).state).toBe("other");
    expect(await leaseOf("tab-a")).toEqual({ state: "mine" });

    const tab = (holder: string) => {
      const client = new ChatClient({
        threadId: session.id,
        persistence: true,
        tools: approvalToolDefinitions,
        connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${session.id}`, {
          headers: { [sessionHolderHeader]: holder },
          fetchClient: (input, init) =>
            runtime.runPromise(
              (init?.method ?? "GET") === "POST"
                ? agent.handle(new Request(input, init), session.id)
                : agent.hydrate(new Request(input, init), session.id),
            ),
        }),
      });
      client.attach();
      return client;
    };

    const owner = tab("tab-a");
    await owner.sendMessage("please use the shell");
    await until(() => owner.getInterrupts().length === 1, "the approval request");

    // The read-only tab sees the same conversation and the waiting approval…
    const reader = tab("tab-b");
    await until(() => reader.getInterrupts().length === 1, "the approval in the read-only tab");
    // …but its answer is refused, and so are a new message and a cancel.
    reader.resolveInterrupts(true);
    await until(() => reader.getError() !== undefined, "the refused approval");
    expect(reader.getError()?.message).toContain("423");
    const cancel = await runtime.runPromise(agent.cancel(session.id, "tab-b"));
    expect(cancel.status).toBe(423);

    // The owner leaves; the reader is told the session is free and continues after claiming it.
    await runtime.runPromise(agent.lease(session.id, "tab-a", "release"));
    owner.dispose();
    expect(await leaseOf("tab-b")).toEqual({ state: "free" });
    await runtime.runPromise(agent.lease(session.id, "tab-b", "claim"));
    reader.dispose();
    const continued = tab("tab-b");
    await until(() => continued.getInterrupts().length === 1, "the approval after taking over");
    continued.resolveInterrupts(true);
    await until(
      () =>
        continued
          .getMessages()
          .some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some(
                (part) => part.type === "text" && part.content.includes("approved-output"),
              ),
          ),
      "the answer after approval",
    );
    await until(() => !continued.getIsLoading(), "the run to finish");
    continued.dispose();
  });
});
