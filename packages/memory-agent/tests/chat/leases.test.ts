import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { selectTestModel } from "../support/provider.ts";
import { testAgent } from "../support/test-env.ts";
import { openPage } from "../support/chat-client.ts";
import { freshSession, json } from "./tab.ts";

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

        const owner = yield* openPage(sessionId, "tab-a");
        yield* owner.send("please use the shell");
        expect(owner.pending()).toHaveLength(1);

        // The read-only tab sees the same conversation and the waiting approval…
        const reader = yield* openPage(sessionId, "tab-b");
        expect(reader.pending()).toHaveLength(1);
        // …but its answer is refused, and so are a new message and a cancel.
        expect(yield* Effect.flip(reader.resolve(() => true))).toMatchObject({
          error: "session_in_use",
        });
        expect(yield* Effect.flip(reader.send("hello"))).toMatchObject({ error: "session_in_use" });
        expect((yield* agent.cancel(sessionId, "tab-b")).status).toBe(423);

        // The owner leaves; the reader is told the session is free and continues after claiming it.
        yield* agent.lease(sessionId, "tab-a", "release");
        expect(yield* leaseOf("tab-b")).toEqual({ state: "free" });
        yield* agent.lease(sessionId, "tab-b", "claim");
        const continued = yield* openPage(sessionId, "tab-b");
        expect(continued.pending()).toHaveLength(1);
        yield* continued.resolve(() => true);
        expect(continued.answer()).toContain("approved-output");
      }),
  );
});
