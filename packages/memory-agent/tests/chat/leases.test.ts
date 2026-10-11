import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { selectTestModel } from "../support/provider.ts";
import { testAgent } from "../support/test-env.ts";
import { freshSession, json, openTab, sdk, until } from "./tab.ts";

const Lease = Schema.Union([
  Schema.Struct({ state: Schema.Literal("mine") }),
  Schema.Struct({ state: Schema.Literal("other"), since: Schema.Finite }),
  Schema.Struct({ state: Schema.Literal("free") }),
]);
const StatusLease = Schema.Struct({ lease: Lease });

testAgent({ testProvider: {} })("session leases", (it) => {
  it.effect(
    "a page that does not hold the session can read it but not send, approve or cancel",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const sessionId = yield* freshSession;
        const agent = yield* AgentChat;
        const leaseOf = (holder: string) =>
          agent.status(sessionId, holder).pipe(
            Effect.flatMap(json),
            Effect.flatMap(Schema.decodeUnknownEffect(StatusLease)),
            Effect.map((status) => status.lease),
          );

        yield* agent.lease(sessionId, "tab-a", "claim");
        // A second tab asks too and is refused.
        const refused = yield* agent.lease(sessionId, "tab-b", "claim");
        expect((yield* Schema.decodeUnknownEffect(Lease)(yield* json(refused))).state).toBe(
          "other",
        );
        expect(yield* leaseOf("tab-a")).toEqual({ state: "mine" });

        const owner = yield* openTab(sessionId, "tab-a");
        yield* Effect.forkChild(
          sdk(() => owner.client.sendMessage("please use the shell")),
          { startImmediately: true },
        );
        yield* until(() => owner.client.getInterrupts().length === 1, "the approval request");

        // The read-only tab sees the same conversation and the waiting approval…
        const reader = yield* openTab(sessionId, "tab-b");
        yield* until(
          () => reader.client.getInterrupts().length === 1,
          "the approval in the read-only tab",
        );
        // …but its answer is refused, and so are a new message and a cancel.
        reader.client.resolveInterrupts(true);
        yield* until(() => reader.client.getError() !== undefined, "the refused approval");
        expect(reader.client.getError()?.message).toContain("423");
        expect((yield* agent.cancel(sessionId, "tab-b")).status).toBe(423);

        // The owner leaves; the reader is told the session is free and continues after claiming it.
        yield* agent.lease(sessionId, "tab-a", "release");
        owner.client.dispose();
        expect(yield* leaseOf("tab-b")).toEqual({ state: "free" });
        yield* agent.lease(sessionId, "tab-b", "claim");
        reader.client.dispose();
        const continued = yield* openTab(sessionId, "tab-b");
        yield* until(
          () => continued.client.getInterrupts().length === 1,
          "the approval after taking over",
        );
        continued.client.resolveInterrupts(true);
        yield* until(
          () => continued.answer().includes("approved-output"),
          "the answer after approval",
        );
        yield* until(() => !continued.client.getIsLoading(), "the run to finish");
      }),
  );
});
