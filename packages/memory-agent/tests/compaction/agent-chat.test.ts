import { Effect, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { ApiUsage } from "../../src/agent/api-usage.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import { budgetFor, turnSummariesNamespace } from "../../src/agent/compaction.ts";
import { TurnSummaries } from "../../src/agent/turn-summaries.ts";
import { AgUiEvent } from "../../src/loop/chunks.ts";
import { RunStore } from "../../src/loop/store.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { runTurn } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { call, conversation, nextRequest } from "./fixtures.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodeStatus = Schema.decodeUnknownEffect(
  Schema.Struct({
    context: Schema.Struct({
      usedTokens: Schema.NullOr(Schema.Finite),
      cachedTokens: Schema.NullOr(Schema.Finite),
      cacheRatio: Schema.NullOr(Schema.Finite),
      compactionStage: Schema.NullOr(
        Schema.Literals(["none", "clear-answered", "summarize", "leave-out"]),
      ),
      windowTokens: Schema.Finite,
      compactAtTokens: Schema.Finite,
    }),
  }),
);
const decodeStoredSummaries = Schema.decodeUnknownEffect(
  Schema.Struct({ blocks: Schema.Array(Schema.Unknown) }),
);

/** A fresh session in the shared agent, with the default test model selected. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  yield* selectTestModel();
  const session = yield* (yield* Sessions).create(project.id);
  return { projectId: project.id, sessionId: session.id };
});

/** Sends one user turn as the page does, returning its run's events. */
const send = (sessionId: string, runId: string, text: string) =>
  runTurn(sessionId, `${sessionId}:${runId}`, text);

const lastInvocation = Effect.map(TestEnv, ({ provider }) =>
  provider === undefined
    ? expect.unreachable("the block has a test provider")
    : provider.invocations.at(-1)!.history,
);

/** A recorded conversation, saved as the session's thread. */
const savedConversation = Effect.fnUntraced(function* (
  at: { readonly projectId: string; readonly sessionId: string },
  answers: readonly string[],
) {
  const recorded = yield* conversation(yield* Nodes, at, answers);
  yield* (yield* RunStore).saveThread(at.sessionId, recorded.messages);
  return recorded;
});

testAgent({ testProvider: {} })("compaction through AgentChat", (it) => {
  it.effect(
    "AgentChat sends earlier turns to a changed model without rewriting stored history",
    () =>
      Effect.gen(function* () {
        const { sessionId } = yield* freshSession;
        const { thread } = yield* RunStore;
        expect(
          (yield* send(sessionId, "before-switch", "빌드 결과를 검증해 줘")).find(
            AgUiEvent.guards.RUN_ERROR,
          ),
        ).toBeUndefined();
        const before = yield* thread(sessionId);
        yield* selectTestModel("deep-1", "medium");
        expect(
          (yield* send(sessionId, "after-switch", "이어서해줘")).find(AgUiEvent.guards.RUN_ERROR),
        ).toBeUndefined();
        const request = yield* lastInvocation;
        expect(request[0]?.content).toContain("The model changed in this conversation");
        expect(request).toContainEqual(
          expect.objectContaining({ role: "user", content: "빌드 결과를 검증해 줘" }),
        );
        expect(request).toContainEqual(
          expect.objectContaining({ role: "user", content: "이어서해줘" }),
        );
        const saved = yield* thread(sessionId);
        expect(saved.slice(0, before.length)).toEqual(before);
        expect(saved.some((message) => message.content === request[0]?.content)).toBe(false);
        yield* send(sessionId, "same-new-model", "계속 검증해 줘");
        expect((yield* lastInvocation)[0]?.content).toContain(
          "The model changed in this conversation",
        );
      }),
  );

  it.effect(
    "/compact summarizes earlier turns and clears answered output for the runs that follow",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const agent = yield* AgentChat;
        const { userNodes, messages, toolOutput, toolResult } = yield* savedConversation(at, [
          "모두 통과했어요.",
          "네",
          "네",
          "네",
          "네",
        ]);
        yield* agent.lease(at.sessionId, "tab-a", "claim");
        expect(yield* Effect.flip(agent.compact(at.sessionId, "tab-b"))).toEqual({
          error: "session_in_use",
        });
        expect(yield* Effect.flip(agent.compact(`${at.sessionId}:missing`, "tab-a"))).toEqual({
          error: "session_not_found",
        });
        const first = yield* agent.compact(at.sessionId, "tab-a");
        // Explicit /compact is not gated by the old 25%-of-window threshold.
        expect(first.tokensBefore).toBeLessThan(258_400 * 0.25);
        // The latest two stay raw. Answered tool output is already pointerized by automatic compaction.
        expect(first).toMatchObject({ cleared: 0, summarizedTurns: 4, summaryFailed: false });
        expect(first.tokensAfter).toBeLessThan(first.tokensBefore);
        expect(yield* agent.compact(at.sessionId, "tab-a")).toEqual({
          cleared: 0,
          summarizedTurns: 0,
          summaryFailed: false,
          tokensBefore: first.tokensAfter,
          tokensAfter: first.tokensAfter,
        });
        // The next question gets the summary, however small the conversation.
        const sent = yield* nextRequest(
          [
            ...messages,
            { role: "assistant", content: "네" },
            { role: "user", content: "다음 질문" },
          ],
          at.sessionId,
        );
        expect(sent[0]).toEqual({
          role: "assistant",
          content: expect.stringContaining(`- 사용자 턴 4개 (node ${userNodes[0]!.id})`),
        });
        expect(sent[1]).toEqual({ role: "user", content: "질문 5" });
        expect(yield* stringifyJson(sent)).not.toContain(toolResult.id);
        // The saved conversation still has everything.
        const kept = yield* (yield* RunStore).thread(at.sessionId);
        expect(kept.find((message) => message.role === "tool")?.content).toBe(toolOutput);
      }),
  );

  it.effect(
    "/compact after automatic summary catch-up adds no reduction to the pilot's next request",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const { userNodes, messages } = yield* savedConversation(at, [
          "네",
          "네",
          "네",
          "네",
          "네",
        ]);
        // The pilot forces automatic catch-up before B's manual call: four older user turns
        // are already summarized and the two most recent user turns must stay raw.
        yield* (yield* RunStore).metadata.set(turnSummariesNamespace, at.sessionId, {
          blocks: [{ end: 4, nextTurnNodeId: userNodes[4]!.id, text: "- 결정 보존" }],
        });
        const before = yield* nextRequest(messages, at.sessionId, budgetFor(200_000));
        const result = yield* (yield* AgentChat).compact(at.sessionId, null);
        expect(result).toMatchObject({ cleared: 0, summarizedTurns: 0, summaryFailed: false });
        expect(yield* nextRequest(messages, at.sessionId, budgetFor(200_000))).toEqual(before);
      }),
  );

  it.effect("automatic summaries wait until the conversation fills the configured share", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      yield* savedConversation(at, ["네", "네", "네", "네", "네"]);
      const summaries = yield* TurnSummaries;
      const { metadata } = yield* RunStore;
      const blocks = metadata.get(turnSummariesNamespace, at.sessionId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed([]),
            onSome: (stored) => Effect.map(decodeStoredSummaries(stored), (found) => found.blocks),
          }),
        ),
      );

      expect(yield* summaries.startPercent).toBe(25);
      expect(yield* summaries.catchUp(at.sessionId, false)).toBe("done");
      expect(yield* blocks).toEqual([]);

      yield* summaries.setStartPercent(0);
      yield* Effect.addFinalizer(() => Effect.orDie(summaries.setStartPercent(25)));
      expect(yield* summaries.catchUp(at.sessionId, false)).toBe("done");
      expect(yield* blocks).toHaveLength(1);
    }),
  );
});

// The responder reports a cache hit only on the provider's first request, so it needs its own agent.
testAgent({
  testProvider: {
    responder: (invocation) => {
      const cacheRead = invocation.index === 0 ? 30 : 0;
      return {
        text: "ok",
        usage: {
          inputTokens: { uncached: 120 - cacheRead, total: 120, cacheRead },
          outputTokens: { total: 5 },
        },
      };
    },
  },
})("context usage reporting", (it) => {
  it.effect("reports prompt cache usage across consecutive requests and distinguishes zero", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* freshSession;
      const status = Effect.gen(function* () {
        const response = yield* (yield* AgentChat).status(sessionId, null);
        return (yield* decodeStatus(yield* call(() => response.json()))).context;
      });
      const events = (runId: string) => send(sessionId, runId, "hello");
      expect(yield* status).toEqual({
        usedTokens: null,
        cachedTokens: null,
        cacheRatio: null,
        compactionStage: null,
        windowTokens: 200_000,
        compactAtTokens: 0,
      });
      expect(
        (yield* events("run-1")).some(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "memory-agent.context",
        ),
      ).toBe(true);
      expect(yield* status).toMatchObject({
        usedTokens: 120,
        cachedTokens: 30,
        cacheRatio: 0.25,
        compactionStage: "none",
      });
      yield* events("run-2");
      expect(yield* status).toMatchObject({
        usedTokens: 120,
        cachedTokens: 0,
        cacheRatio: 0,
        compactionStage: "none",
      });
      expect(yield* (yield* ApiUsage).byRootSession(sessionId)).toMatchObject({
        responses: 2,
        inputTokens: 240,
        outputTokens: 10,
        cacheReadTokens: 30,
        uncachedInputTokens: 210,
      });
    }),
  );
});
