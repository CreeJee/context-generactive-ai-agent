import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { selectTestModel } from "../support/provider.ts";
import { testAgent } from "../support/test-env.ts";
import { openPage } from "../support/chat-client.ts";
import { freshSession, invocationsOf } from "./tab.ts";

testAgent({ testProvider: {} })("two pages", (it) => {
  it.effect(
    "two pages both operate one session; a late answer to an approval another page answered starts no run",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const sessionId = yield* freshSession;
        const agent = yield* AgentChat;
        const invocations = yield* invocationsOf(sessionId);

        const owner = yield* openPage(sessionId, "tab-a");
        yield* owner.send("please use the shell");
        expect(owner.pending()).toHaveLength(1);

        // The second tab sees the same conversation and the waiting approval, and answers it.
        const reader = yield* openPage(sessionId, "tab-b");
        expect(reader.pending()).toHaveLength(1);
        yield* reader.resolve(() => true);
        expect(reader.answer()).toContain("approved-output");
        const answered = invocations().length;

        // The first tab still shows the approval; its late answer is refused and calls no model.
        expect(yield* Effect.flip(owner.resolve(() => true))).toMatchObject({
          error: "approval_not_pending",
        });
        expect(invocations()).toHaveLength(answered);
        // No run is going, so a cancel from either tab has nothing to stop.
        expect(yield* Effect.flip(agent.cancel(sessionId, "tab-b"))).toEqual({
          error: "no_running_run",
        });
      }),
  );
});
