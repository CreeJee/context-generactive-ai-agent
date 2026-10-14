import type { ModelMessage } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { ApiUsage } from "../../src/agent/api-usage.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import {
  budgetFor,
  compaction,
  turnSummariesNamespace,
  type Budget,
} from "../../src/agent/compaction.ts";
import { TurnSummaries } from "../../src/agent/turn-summaries.ts";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { call, conversation, firstSent, noLimit, sourcesOf } from "./fixtures.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodeCompact = Schema.decodeUnknownEffect(
  Schema.Struct({
    cleared: Schema.Finite,
    summarizedTurns: Schema.Finite,
    summaryFailed: Schema.Boolean,
    tokensBefore: Schema.Finite,
    tokensAfter: Schema.Finite,
  }),
);
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
  Schema.NullishOr(Schema.Struct({ blocks: Schema.Array(Schema.Unknown) })),
);
const StreamEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    name: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
);

/** A fresh session in the shared agent, with the default test model selected. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  yield* selectTestModel();
  const session = yield* (yield* Sessions).create(project.id);
  return { projectId: project.id, sessionId: session.id };
});

/** Post one user message to AgentChat the way the page does, returning the SSE body. */
const send = Effect.fnUntraced(function* (sessionId: string, runId: string, text: string) {
  const response = yield* (yield* AgentChat).handle(
    new Request("http://127.0.0.1/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: yield* stringifyJson({
        threadId: sessionId,
        runId: `${sessionId}:${runId}`,
        messages: [{ id: `${sessionId}:${runId}-message`, role: "user", content: text }],
        tools: [],
        context: [],
      }),
    }),
    sessionId,
  );
  expect(response.status).toBe(200);
  return yield* call(() => response.text());
});

const lastInvocation = Effect.map(TestEnv, ({ provider }) =>
  provider === undefined
    ? expect.unreachable("the block has a test provider")
    : provider.adapter.invocations.at(-1)!.messages,
);

/** What the model is sent next, under automatic compaction alone. */
const nextRequest = Effect.fnUntraced(function* (
  messages: readonly ModelMessage[],
  sessionId: string,
  budget: Budget = { compactAt: noLimit, leaveOutAt: noLimit },
) {
  const { metadata } = (yield* ChatState).persistence.stores;
  const sources = sourcesOf(yield* Nodes, sessionId);
  return yield* firstSent(messages, compaction(metadata, sources, budget), sessionId);
});

/** A recorded conversation, saved as the session's thread. */
const savedConversation = Effect.fnUntraced(function* (
  at: { readonly projectId: string; readonly sessionId: string },
  answers: readonly string[],
) {
  const recorded = conversation(yield* Nodes, at, answers);
  const { stores } = (yield* ChatState).persistence;
  yield* call(() => stores.messages.saveThread(at.sessionId, recorded.messages));
  return recorded;
});

const compactSession = Effect.fnUntraced(function* (sessionId: string, holder: string | null) {
  const response = yield* (yield* AgentChat).compact(sessionId, holder);
  return {
    status: response.status,
    body: yield* decodeCompact(yield* call(() => response.json())),
  };
});

testAgent({ testProvider: {} })("compaction through AgentChat", (it) => {
  it.effect(
    "AgentChat sends earlier turns to a changed model without rewriting stored history",
    () =>
      Effect.gen(function* () {
        const { sessionId } = yield* freshSession;
        const { messages } = (yield* ChatState).persistence.stores;
        expect(yield* send(sessionId, "before-switch", "빌드 결과를 검증해 줘")).not.toContain(
          '"type":"RUN_ERROR"',
        );
        const before = yield* call(() => messages.loadThread(sessionId));
        yield* selectTestModel("deep-1", "medium");
        expect(yield* send(sessionId, "after-switch", "이어서해줘")).not.toContain(
          '"type":"RUN_ERROR"',
        );
        const request = yield* lastInvocation;
        expect(request[0]?.content).toContain("The model changed in this conversation");
        expect(request).toContainEqual(
          expect.objectContaining({ role: "user", content: "빌드 결과를 검증해 줘" }),
        );
        expect(request).toContainEqual(
          expect.objectContaining({ role: "user", content: "이어서해줘" }),
        );
        const saved = yield* call(() => messages.loadThread(sessionId));
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
        expect((yield* agent.compact(at.sessionId, "tab-b")).status).toBe(423);
        expect((yield* agent.compact(`${at.sessionId}:missing`, "tab-a")).status).toBe(404);
        const first = yield* compactSession(at.sessionId, "tab-a");
        expect(first.status).toBe(200);
        // Explicit /compact is not gated by the old 25%-of-window threshold.
        expect(first.body.tokensBefore).toBeLessThan(258_400 * 0.25);
        // The latest two stay raw. Answered tool output is already pointerized by automatic compaction.
        expect(first.body).toMatchObject({ cleared: 0, summarizedTurns: 4, summaryFailed: false });
        expect(first.body.tokensAfter).toBeLessThan(first.body.tokensBefore);
        expect((yield* compactSession(at.sessionId, "tab-a")).body).toEqual({
          cleared: 0,
          summarizedTurns: 0,
          summaryFailed: false,
          tokensBefore: first.body.tokensAfter,
          tokensAfter: first.body.tokensAfter,
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
        const { stores } = (yield* ChatState).persistence;
        const kept = yield* call(() => stores.messages.loadThread(at.sessionId));
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
        const { metadata } = (yield* ChatState).persistence.stores;
        yield* call(() =>
          metadata.set(turnSummariesNamespace, at.sessionId, {
            blocks: [{ end: 4, nextTurnNodeId: userNodes[4]!.id, text: "- 결정 보존" }],
          }),
        );
        const before = yield* nextRequest(messages, at.sessionId, budgetFor(200_000));
        const result = yield* compactSession(at.sessionId, null);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ cleared: 0, summarizedTurns: 0, summaryFailed: false });
        expect(yield* nextRequest(messages, at.sessionId, budgetFor(200_000))).toEqual(before);
      }),
  );

  it.effect("automatic summaries wait until the conversation fills the configured share", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      yield* savedConversation(at, ["네", "네", "네", "네", "네"]);
      const summaries = yield* TurnSummaries;
      const { metadata } = (yield* ChatState).persistence.stores;
      const blocks = call(() => metadata.get(turnSummariesNamespace, at.sessionId)).pipe(
        Effect.flatMap(decodeStoredSummaries),
        Effect.map((stored) => stored?.blocks ?? []),
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
    responder: (invocation) => ({
      text: "ok",
      usage: {
        promptTokens: 120,
        completionTokens: 5,
        totalTokens: 125,
        promptTokensDetails: { cachedTokens: invocation.index === 0 ? 30 : 0 },
      },
    }),
  },
})("context usage reporting", (it) => {
  it.effect("reports prompt cache usage across consecutive requests and distinguishes zero", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* freshSession;
      const status = Effect.gen(function* () {
        const response = yield* (yield* AgentChat).status(sessionId, null);
        return (yield* decodeStatus(yield* call(() => response.json()))).context;
      });
      const events = Effect.fnUntraced(function* (runId: string) {
        const body = yield* send(sessionId, runId, "hello");
        return yield* Effect.forEach(
          body.split("\n").filter((line) => line.startsWith("data: ")),
          (line) => Schema.decodeEffect(StreamEvent)(line.slice(6)),
        );
      });
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
          (event) => event.type === "CUSTOM" && event.name === "memory-agent.context",
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
      expect((yield* ApiUsage).byRootSession(sessionId)).toMatchObject({
        responses: 2,
        inputTokens: 240,
        outputTokens: 10,
        cacheReadTokens: 30,
        uncachedInputTokens: 210,
      });
    }),
  );
});
