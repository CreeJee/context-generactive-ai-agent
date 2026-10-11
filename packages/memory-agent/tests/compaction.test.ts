import { isTruthy } from "../src/truthy.ts";
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { chat, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { Cause, Crypto, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat, modelBoundMessages } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import {
  coldObservationId,
  consumeColdObservation,
  contextUsageNamespace,
  pendingColdObservation,
  type StoredContextUsage,
} from "../src/agent/context-usage.ts";
import {
  budgetFor,
  clearedOutput,
  compact,
  compaction,
  estimateConversation,
  estimateTokens,
  lightweightToolResults,
  turnSummariesNamespace,
  type Budget,
  type CompactionSources,
} from "../src/agent/compaction.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes, type Node } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { MemoryTools } from "../src/tools/memory.ts";
import { testRuntime } from "./support/runtime.ts";
import { selectTestModel } from "./support/provider.ts";

const call = Effect.fn("compaction.sdkCall")(<A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Records the conversation as the engine keeps it, whatever the model was sent. */
function canonical() {
  let latest: readonly ModelMessage[] = [];
  const middleware: ChatMiddleware = {
    name: "test/canonical",
    onFinish: (ctx) => {
      latest = [...ctx.messages];
    },
  };
  return { saved: () => latest, middleware };
}

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
const StreamEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    name: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
);

const drain = Effect.fn("compaction.drain")(<A>(stream: AsyncIterable<A>) =>
  Stream.runDrain(Stream.fromAsyncIterable(stream, (cause) => new Cause.UnknownError(cause))),
);

const noLimit = 1_000_000;

it.live(
  "image inlining uses the compacted provider history, not an older image in the transcript",
  () =>
    Effect.gen(function* () {
      const image = {
        type: "image" as const,
        source: { type: "url" as const, value: "/old-image" },
      };
      const messages: ModelMessage[] = [
        { role: "user", content: [image] },
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "current question" },
      ];
      const result = yield* call(() =>
        compact(
          messages,
          {
            manual: { clearedThrough: 0, summarizedTurns: 0 },
            blocks: [{ end: 1, nextTurnNodeId: "next", text: "Earlier image discussed." }],
          },
          { toolResultId: () => null, nodeText: () => "current question" },
          budgetFor(noLimit),
        ),
      );
      expect(result.stage).toBe("summarize");
      const providerMessages = modelBoundMessages({
        messages,
        providerMessages: [...result.messages],
      });
      expect(providerMessages).toEqual(result.messages);
      expect(providerMessages.some((message) => Array.isArray(message.content))).toBe(false);
      expect(modelBoundMessages({ messages })).toBe(messages);
    }),
);

const sourcesOf = (nodes: Effect.Success<typeof Nodes>, sessionId: string) =>
  ({
    toolResultId: (toolCallId) => nodes.toolResultId(sessionId, toolCallId),
    nodeText: (id) => nodes.get(id)?.text ?? null,
  }) satisfies CompactionSources;

it.live(
  "tool result lookup returns the first recorded node without materializing the session",
  () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* call(() => testRuntime());
      const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
      const at = { projectId: project.id, sessionId: session.id };
      const first = nodes.append({
        ...at,
        kind: "tool_result",
        text: "first",
        detail: { toolCallId: "same-call" },
      });
      nodes.append({
        ...at,
        kind: "tool_result",
        text: "second",
        detail: { toolCallId: "same-call" },
      });
      expect(nodes.toolResultId(session.id, "same-call")).toBe(first.id);
      expect(nodes.toolResultId(session.id, "missing")).toBeNull();
    }),
);

/** What the model is sent on the first call of a run over `messages`. */
const firstSent = Effect.fn("compaction.firstSent")(function* (
  messages: readonly ModelMessage[],
  middleware: ChatMiddleware,
  threadId?: string,
) {
  const services = yield* Layer.build(NodeCrypto.layer);
  const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
  const id = threadId ?? (yield* crypto.randomUUIDv4());
  const adapter = new ScriptedTextAdapter([{ text: "네" }]);
  yield* drain(chat({ adapter, threadId: id, messages: [...messages], middleware: [middleware] }));
  return adapter.invocations[0]?.messages ?? [];
});

it.live("omits empty stored user text from provider input without erasing tool-only answers", () =>
  Effect.gen(function* () {
    const messages: ModelMessage[] = [
      { role: "user", content: "" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "call", content: "result" },
      { role: "user", content: "continue" },
    ];
    const middleware = compaction(
      memoryPersistence().stores.metadata,
      { toolResultId: () => null, nodeText: () => null },
      budgetFor(noLimit),
    );
    expect(yield* firstSent(messages, middleware)).toEqual(messages.slice(1));
    expect(messages[0]?.content).toBe("");
  }),
);

/**
 * A conversation of `answers.length + 1` user turns, recorded in memory the way runs record it.
 * The first answer used a tool.
 */
function conversation(
  nodes: Effect.Success<typeof Nodes>,
  at: { readonly projectId: string; readonly sessionId: string },
  answers: readonly string[],
) {
  const userNodes: Node[] = [];
  const messages: ModelMessage[] = [];
  const toolOutput = "테스트 결과 ".repeat(200);
  let toolResult: Node | null = null;
  answers.forEach((answer, index) => {
    const question = `질문 ${index + 1}`;
    userNodes.push(nodes.append({ ...at, kind: "user", text: question }));
    messages.push({ role: "user", content: question });
    if (index === 0) {
      nodes.append({
        ...at,
        kind: "tool_call",
        text: 'run_shell {"command":"pnpm test"}',
        detail: { toolName: "run_shell", toolCallId: "old-1" },
      });
      toolResult = nodes.append({
        ...at,
        kind: "tool_result",
        text: toolOutput,
        detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
      });
      messages.push(
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "old-1",
              type: "function",
              function: { name: "run_shell", arguments: '{"command":"pnpm test"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "old-1", content: toolOutput },
      );
    }
    nodes.append({ ...at, kind: "assistant", text: answer });
    messages.push({ role: "assistant", content: answer });
  });
  const last = `질문 ${answers.length + 1}`;
  userNodes.push(nodes.append({ ...at, kind: "user", text: last }));
  messages.push({ role: "user", content: last });
  return { userNodes, messages, toolOutput, toolResult: toolResult! };
}

describe("cache-cold observation", () => {
  const usage = (
    cachedTokens: number | null,
    observationId: string | null,
  ): StoredContextUsage => ({
    inputTokens: 100,
    cachedTokens,
    observationId,
    compactionStage: "none",
  });

  test("only explicit identifiable zero triggers, once per provider observation", () => {
    expect(coldObservationId(null, null)).toBeNull();
    expect(coldObservationId(usage(null, "first"), null)).toBeNull();
    expect(coldObservationId(usage(12, "first"), null)).toBeNull();
    expect(coldObservationId(usage(0, null), null)).toBeNull();
    expect(coldObservationId(usage(0, "first"), null)).toBe("first");
    expect(coldObservationId(usage(0, "first"), "first")).toBeNull();
    expect(coldObservationId(usage(0, "second"), "first")).toBe("second");
  });

  it.live("persists consumption while legacy/missing usage keeps its existing behavior", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const metadata = yield* Effect.provideContext(
        Effect.map(ChatState, (state) => state.persistence.stores.metadata),
        yield* runtime.contextEffect,
      );
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBeNull();
      yield* call(() =>
        metadata.set(contextUsageNamespace, session.id, { inputTokens: 100, cachedTokens: 0 }),
      );
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBeNull();
      yield* call(() => metadata.set(contextUsageNamespace, session.id, usage(0, "first")));
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBe("first");
      yield* call(() => consumeColdObservation(metadata, session.id, "first"));
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBeNull();
      yield* call(() => metadata.set(contextUsageNamespace, session.id, usage(0, "second")));
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBe("second");
      yield* call(() => metadata.set(contextUsageNamespace, session.id, { inputTokens: 100 }));
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBeNull();
    }),
  );
});

describe("compaction", () => {
  it.live("AgentChat restores model changes from evidence without rewriting stored history", () =>
    Effect.gen(function* () {
      const setup = yield* call(() =>
        testRuntime({ testProvider: { responder: () => ({ text: "answer" }) } }),
      );
      const { runtime, session } = setup;
      yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
      const agent = yield* Effect.provideContext(AgentChat, yield* runtime.contextEffect);
      const run = Effect.fn("compaction.run")(function* (runId: string, text: string) {
        const response = yield* Effect.provideContext(
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* stringifyJson({
                threadId: session.id,
                runId,
                messages: [{ id: `${runId}-message`, role: "user", content: text }],
                tools: [],
                context: [],
              }),
            }),
            session.id,
          ),
          yield* runtime.contextEffect,
        );
        expect(response.status).toBe(200);
        expect(yield* call(() => response.text())).not.toContain('"type":"RUN_ERROR"');
      });
      yield* run("before-switch", "빌드 결과를 검증해 줘");
      const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
      const before = yield* call(() => state.persistence.stores.messages.loadThread(session.id));
      yield* selectTestModel("deep-1", "medium").pipe(
        Effect.provideContext(yield* runtime.contextEffect),
      );
      yield* run("after-switch", "이어서해줘");
      const request = setup.provider!.adapter.invocations.at(-1)!.messages;
      expect(request[0]?.content).toContain("Context restored after a model change");
      expect(request[0]?.content).toContain("node ");
      expect(request).toContainEqual(
        expect.objectContaining({ role: "user", content: "이어서해줘" }),
      );
      const saved = yield* call(() => state.persistence.stores.messages.loadThread(session.id));
      expect(saved.slice(0, before.length)).toEqual(before);
      expect(saved.some((message) => message.content === request[0]?.content)).toBe(false);
      yield* run("same-new-model", "계속 검증해 줘");
      expect(setup.provider!.adapter.invocations.at(-1)?.messages[0]?.content).toContain(
        "Context restored after a model change",
      );
    }),
  );
  test("shortens recorded tool outputs in provider copy while preserving status and evidence ID", () => {
    const output = JSON.stringify({
      status: "failed",
      exitCode: 2,
      signal: null,
      durationMs: 9,
      stdout: "log".repeat(3_000),
      stderr: `${"error".repeat(1_000)}FINAL DIAGNOSTIC`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "run_shell", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: output },
    ];
    const provider = lightweightToolResults(messages, (id) => (id === "call-1" ? "node-1" : null));
    expect(provider[1]?.content).toContain("status");
    expect(provider[1]?.content).toContain("failed");
    expect(provider[1]?.content).toContain("exitCode");
    expect(provider[1]?.content).toContain("FINAL DIAGNOSTIC");
    expect(provider[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(provider).length).toBeLessThan(output.length / 2);
    expect(messages[1]?.content).toBe(output);
    expect(lightweightToolResults(messages, () => null)[1]?.content).toBe(output);
    const malformed: ModelMessage[] = [
      messages[0]!,
      {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ error: "denied".repeat(1_000) }),
      },
    ];
    expect(
      lightweightToolResults(malformed, (id) => (id === "call-1" ? "node-1" : null))[1]?.content,
    ).toBe(malformed[1]?.content);
  });

  test("shell preview avoids echoing the command while preserving original and diagnostics", () => {
    const command = "unique-command-".repeat(80);
    const original = JSON.stringify({
      command,
      shell: "/bin/zsh",
      status: "succeeded",
      exitCode: 0,
      signal: null,
      durationMs: 12,
      stdout: "result".repeat(200),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "run_shell", arguments: JSON.stringify({ command }) },
          },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: original },
    ];
    const sent = lightweightToolResults(messages, (id) => (id === "call-1" ? "node-1" : null));
    expect(sent[1]?.content).toContain('"status":"succeeded"');
    expect(sent[1]?.content).toContain('"exitCode":0');
    expect(sent[1]?.content).toContain("read_tool_result ID node-1");
    expect(sent[1]?.content).not.toContain(command);
    expect(sent[1]?.content).not.toContain('"shell":');
    expect(messages[1]?.content).toBe(original);
  });

  test("list/search and reviewed child reports keep navigation and outcome while omitting bulk", () => {
    const cases = [
      {
        name: "list_files",
        result: {
          total: 500,
          paths: Array.from({ length: 500 }, (_, index) => `folder/really-long-file-${index}.ts`),
          nextOffset: 500,
          snapshot: "snap",
          truncated: false,
          excludedCredentialFiles: 0,
        },
        essential: '"nextOffset":500',
      },
      {
        name: "search_files",
        result: {
          matches: Array.from({ length: 100 }, (_, index) => ({
            path: `very-long-folder/name-${index}.ts`,
            line: index + 1,
            text: "snippet".repeat(20),
          })),
          skipped: [],
          filesInView: 100,
          nextCursor: "cursor",
          complete: false,
        },
        essential: '"nextCursor":"cursor"',
      },
      {
        name: "get_subagent_report",
        result: {
          status: "completed",
          subagentId: "child",
          taskId: "task",
          attemptId: "attempt",
          agent: null,
          answer: "final".repeat(4_000),
          error: null,
          evidenceRefIds: ["evidence-1"],
        },
        essential: '"evidenceRefIds":["evidence-1"]',
      },
    ];
    for (const { name, result, essential } of cases) {
      const original = JSON.stringify(result);
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-1", type: "function", function: { name, arguments: "{}" } }],
        },
        { role: "tool", toolCallId: "call-1", content: original },
      ];
      const sent = lightweightToolResults(messages, (id) => (id === "call-1" ? "node-1" : null));
      expect(sent[1]?.content).toContain(essential);
      expect(sent[1]?.content).toContain("read_tool_result ID node-1");
      expect(JSON.stringify(sent).length).toBeLessThan(original.length / 2);
      expect(messages[1]?.content).toBe(original);
    }
  });

  test("shortens a sub-4000-character directory listing by default, without losing navigation", () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/module-${index}.ts`);
    const original = JSON.stringify({
      total: 80,
      paths,
      snapshot: "fixed-snapshot",
      nextOffset: 40,
      truncated: false,
      excludedCredentialFiles: 0,
    });
    expect(original.length).toBeLessThan(4_000);
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: original },
    ];
    const result = lightweightToolResults(messages, (id) => (id === "call-1" ? "node-1" : null));
    expect(result[1]?.content).toContain('"snapshot":"fixed-snapshot"');
    expect(result[1]?.content).toContain('"nextOffset":40');
    expect(result[1]?.content).toContain("src/module-0.ts");
    expect(result[1]?.content).not.toContain("src/module-39.ts");
    expect(result[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(result[1]?.content).length).toBeLessThan(original.length);
    expect(messages[1]?.content).toBe(original);
  });

  it.live(
    "read_tool_result pages the saved original but refuses another conversation and other kinds",
    () =>
      Effect.gen(function* () {
        const { runtime, project, session } = yield* call(() => testRuntime());
        const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
        const other = yield* Effect.provideContext(
          Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
          yield* runtime.contextEffect,
        );
        const text = "saved original".repeat(500);
        const own = nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "tool_result",
          text,
        });
        const foreign = nodes.append({
          projectId: project.id,
          sessionId: other.id,
          kind: "tool_result",
          text,
        });
        const wrongKind = nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "assistant",
          text,
        });
        const memory = yield* Effect.provideContext(MemoryTools, yield* runtime.contextEffect);
        const tools = memory.forRun({
          projectId: project.id,
          sessionId: session.id,
          runId: "r1",
          userNodeId: wrongKind.id,
        }).tools;
        const execute = tools[3]?.execute;
        if (!isTruthy(execute)) throw new Error("read_tool_result unavailable");
        const first = yield* call(() => execute({ id: own.id, offset: 0 }));
        expect(first).toMatchObject({ id: own.id, text: text.slice(0, 4_000), nextOffset: 4_000 });
        expect(yield* call(() => execute({ id: own.id, offset: 4_000 }))).toMatchObject({
          text: text.slice(4_000),
          nextOffset: null,
        });
        expect(yield* call(() => execute({ id: foreign.id }))).toEqual({
          error: "not_found",
          id: foreign.id,
        });
        expect(yield* call(() => execute({ id: wrongKind.id }))).toEqual({
          error: "not_found",
          id: wrongKind.id,
        });
      }),
  );

  it.live("cold usage compacts below the normal threshold on the next request only", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* call(() => testRuntime());
      const { nodes, metadata } = yield* Effect.provideContext(
        Effect.all({
          nodes: Nodes,
          metadata: Effect.map(ChatState, (state) => state.persistence.stores.metadata),
        }),
        yield* runtime.contextEffect,
      );
      const { messages } = conversation(nodes, { projectId: project.id, sessionId: session.id }, [
        "one",
        "two",
        "three",
        "four",
      ]);
      const middleware = compaction(metadata, sourcesOf(nodes, session.id), {
        compactAt: noLimit,
        leaveOutAt: noLimit,
      });
      const sent = () => firstSent(messages, middleware, session.id);
      expect((yield* sent())[0]).toEqual({ role: "user", content: "질문 1" });
      yield* call(() =>
        metadata.set(contextUsageNamespace, session.id, { inputTokens: 100, cachedTokens: null }),
      );
      expect((yield* sent())[0]).toEqual({ role: "user", content: "질문 1" });
      yield* call(() =>
        metadata.set(contextUsageNamespace, session.id, {
          inputTokens: 100,
          cachedTokens: 0,
          observationId: "cold-1",
        }),
      );
      const early = yield* sent();
      expect(early[0]?.content).toContain("earlier messages of this conversation were left out");
      expect(early).toContainEqual({ role: "user", content: "질문 4" });
      expect(early.at(-1)).toEqual({ role: "user", content: "질문 5" });
      expect(yield* call(() => pendingColdObservation(metadata, session.id))).toBeNull();
      // Consumption is durable: the same observation does not trigger again after the first attempt.
      expect((yield* sent())[0]).toEqual({ role: "user", content: "질문 1" });
      yield* call(() =>
        metadata.set(contextUsageNamespace, session.id, {
          inputTokens: 100,
          cachedTokens: 0,
          observationId: "cold-2",
        }),
      );
      expect((yield* sent())[0]?.content).toContain(
        "earlier messages of this conversation were left out",
      );
    }),
  );

  it.live("drops a tool result when compaction has removed its matching tool call", () =>
    Effect.gen(function* () {
      const messages: ModelMessage[] = [
        { role: "assistant", content: "earlier call was compacted" },
        { role: "tool", toolCallId: "orphaned", content: "result without a call" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "paired",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "paired", content: "paired result" },
        { role: "user", content: "continue" },
      ];
      const result = yield* call(() =>
        compact(
          messages,
          { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
          { toolResultId: () => null, nodeText: () => null },
          { compactAt: noLimit, leaveOutAt: noLimit },
        ),
      );
      expect(result.messages).not.toContainEqual(
        expect.objectContaining({ role: "tool", toolCallId: "orphaned" }),
      );
      expect(result.messages).toContainEqual(
        expect.objectContaining({ role: "tool", toolCallId: "paired" }),
      );
      expect(result.stage).toBe("clear-answered");
    }),
  );

  it.live.each([true, false])(
    "omits incomplete historical calls without rewriting the transcript (result: %s)",
    (hasResult) =>
      Effect.gen(function* () {
        const validCall = {
          id: "valid",
          type: "function" as const,
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        };
        const messages: ModelMessage[] = [
          {
            role: "assistant",
            content: "진행 상황을 기록합니다.",
            toolCalls: [
              {
                id: "partial",
                type: "function",
                function: { name: "update_workflow_progress", arguments: '{"detail":"진행 중' },
              },
              validCall,
            ],
          },
          ...(hasResult
            ? [{ role: "tool" as const, toolCallId: "partial", content: "partial result" }]
            : []),
          { role: "tool", toolCallId: "valid", content: "valid result" },
          { role: "user", content: "continue" },
        ];
        const original = structuredClone(messages);
        const result = yield* call(() =>
          compact(
            messages,
            { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
            { toolResultId: () => null, nodeText: () => null },
            { compactAt: noLimit, leaveOutAt: noLimit },
          ),
        );
        expect(result.messages).toEqual([
          { role: "assistant", content: "진행 상황을 기록합니다.", toolCalls: [validCall] },
          { role: "tool", toolCallId: "valid", content: "valid result" },
          { role: "user", content: "continue" },
        ]);
        expect(result.stage).toBe("clear-answered");
        expect(messages).toEqual(original);
      }),
  );

  it.live("clears tool output the model already answered from, and keeps the run's own whole", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* call(() => testRuntime());
      const { nodes, tools, metadata } = yield* Effect.provideContext(
        Effect.all({
          nodes: Nodes,
          tools: Effect.map(MemoryTools, (memory) => memory.forProject(project.id)),
          metadata: Effect.map(ChatState, (state) => state.persistence.stores.metadata),
        }),
        yield* runtime.contextEffect,
      );
      const at = { projectId: project.id, sessionId: session.id };
      const output = "빌드 로그 ".repeat(1_000);
      nodes.append({ ...at, kind: "user", text: "빌드 로그 봐 줘" });
      nodes.append({
        ...at,
        kind: "tool_call",
        text: 'run_shell {"command":"pnpm build"}',
        detail: { toolName: "run_shell", toolCallId: "old-1" },
      });
      const result = nodes.append({
        ...at,
        kind: "tool_result",
        text: output,
        detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
      });
      const messages: ModelMessage[] = [
        { role: "user", content: "빌드 로그 봐 줘" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "old-1",
              type: "function",
              function: { name: "run_shell", arguments: '{"command":"pnpm build"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "old-1", content: output },
        { role: "assistant", content: "빌드는 성공했어요." },
        { role: "user", content: "그 로그 다시 읽어 줘" },
      ];
      const adapter = new ScriptedTextAdapter([
        {
          toolCalls: [
            {
              id: "new-1",
              name: "read_evidence",
              arguments: yield* stringifyJson({ id: result.id }),
            },
          ],
        },
        { text: "다시 읽었어요." },
      ]);
      const { saved, middleware } = canonical();
      // The log (about 4,500 tokens) is over budget; the page read_evidence returns in this run
      // (about 3,000) is not.
      const budget: Budget = { compactAt: 4_000, leaveOutAt: noLimit };
      yield* drain(
        chat({
          adapter,
          messages,
          tools,
          threadId: session.id,
          middleware: [middleware, compaction(metadata, sourcesOf(nodes, session.id), budget)],
        }),
      );
      const [first, second] = adapter.invocations;
      const toolContent = (sent: readonly ModelMessage[] | undefined, id: string) =>
        sent?.find((message) => message.role === "tool" && message.toolCallId === id)?.content;
      // The answered output is replaced by a pointer to its memory node.
      expect(toolContent(first?.messages, "old-1")).toBe(clearedOutput(result.id));
      expect(first?.messages.at(-1)).toEqual({ role: "user", content: "그 로그 다시 읽어 줘" });
      // The output of the call in progress reaches the model whole.
      expect(toolContent(second?.messages, "old-1")).toBe(clearedOutput(result.id));
      expect(toolContent(second?.messages, "new-1")).toEqual(
        expect.stringContaining("빌드 로그 빌드 로그"),
      );
      // The conversation that is saved keeps every output.
      expect(toolContent(saved(), "old-1")).toBe(output);
    }),
  );

  it.live(
    "sends earlier turns as their summaries once clearing is not enough, if they still fit",
    () =>
      Effect.gen(function* () {
        const { runtime, project, session } = yield* call(() => testRuntime());
        const { nodes, metadata } = yield* Effect.provideContext(
          Effect.all({
            nodes: Nodes,
            metadata: Effect.map(ChatState, (state) => state.persistence.stores.metadata),
          }),
          yield* runtime.contextEffect,
        );
        const long = "배포 절차를 설명해요. ".repeat(50);
        const { userNodes, messages } = conversation(
          nodes,
          { projectId: project.id, sessionId: session.id },
          [long, long, long, long, long],
        );
        yield* call(() =>
          metadata.set(turnSummariesNamespace, session.id, {
            blocks: [{ end: 2, nextTurnNodeId: userNodes[2]!.id, text: "- 배포 절차를 정했다" }],
          }),
        );
        const sources = sourcesOf(nodes, session.id);
        const sent = (budget: Budget, conversation: readonly ModelMessage[]) =>
          firstSent(conversation, compaction(metadata, sources, budget), session.id);
        const firstBlock = yield* sent({ compactAt: 1_000, leaveOutAt: noLimit }, messages);
        expect(firstBlock[0]).toEqual({
          role: "assistant",
          content: expect.stringContaining("user turns 1-2"),
        });
        expect(firstBlock[0]?.content).toContain("- 배포 절차를 정했다");
        expect(firstBlock[1]).toEqual({ role: "user", content: "질문 3" });
        expect(firstBlock.at(-1)).toEqual({ role: "user", content: "질문 6" });
        yield* call(() =>
          metadata.set(turnSummariesNamespace, session.id, {
            blocks: [
              { end: 2, nextTurnNodeId: userNodes[2]!.id, text: "- 배포 절차를 정했다" },
              { end: 4, nextTurnNodeId: userNodes[4]!.id, text: "- 배포 검증을 마쳤다" },
            ],
          }),
        );
        const twoBlocks = yield* sent({ compactAt: 1_000, leaveOutAt: noLimit }, messages);
        expect(twoBlocks[0]).toEqual(firstBlock[0]);
        expect(twoBlocks[1]?.content).toContain("user turns 3-4");
        expect(twoBlocks[2]).toEqual({ role: "user", content: "질문 5" });
        // Ready blocks already applied below the former 25% gate; removing that dead gate must not
        // resummarize or restore raw turns. The live request keeps the latest user message last.
        const lowUsage = budgetFor(200_000);
        expect(estimateConversation(messages)).toBeLessThan(200_000 * 0.25);
        expect(lowUsage.compactAt).toBe(0);
        expect(yield* sent(lowUsage, messages)).toEqual(twoBlocks);
        expect(twoBlocks.at(-1)).toEqual({ role: "user", content: "질문 6" });
        expect(yield* sent({ compactAt: noLimit, leaveOutAt: noLimit }, messages)).toEqual(
          twoBlocks,
        );
        // A conversation whose turn 3 is not the one summarized gets no summary.
        const other = messages.map((message) =>
          message.role === "user" && message.content === "질문 3"
            ? { ...message, content: "다른 질문" }
            : message,
        );
        expect((yield* sent({ compactAt: 1_000, leaveOutAt: noLimit }, other))[0]).toEqual({
          role: "user",
          content: "질문 1",
        });
      }),
  );

  it.live("leaves out the oldest messages, pointing to memory, when nothing else is enough", () =>
    Effect.gen(function* () {
      const { runtime } = yield* call(() => testRuntime());
      const metadata = yield* Effect.provideContext(
        Effect.map(ChatState, (state) => state.persistence.stores.metadata),
        yield* runtime.contextEffect,
      );
      const long = "배포 절차를 설명해요. ".repeat(100);
      const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => [
        { role: "user" as const, content: `질문 ${index}: ${long}` },
        { role: "assistant" as const, content: `답 ${index}: ${long}` },
      ]).flat();
      messages.push({ role: "user", content: "마지막 질문" });
      const sources: CompactionSources = { toolResultId: () => null, nodeText: () => null };
      const sent = yield* firstSent(
        messages,
        compaction(metadata, sources, { compactAt: 3_000, leaveOutAt: 3_000 }),
      );
      expect(sent.length).toBeLessThan(messages.length);
      expect(sent[0]?.content).toContain("find_memory");
      expect(sent.at(-1)).toEqual({ role: "user", content: "마지막 질문" });
    }),
  );

  it.live(
    "adds bounded retrieval only after compaction omitted content, and continues on failure",
    () =>
      Effect.gen(function* () {
        const messages: ModelMessage[] = [
          { role: "user", content: "earlier question" },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "old-1",
                type: "function",
                function: { name: "run_shell", arguments: "{}" },
              },
            ],
          },
          { role: "tool", toolCallId: "old-1", content: "large earlier output" },
          { role: "assistant", content: "done" },
          { role: "user", content: "current question" },
        ];
        let appendixCalls = 0;
        const sources: CompactionSources = {
          toolResultId: (toolCallId) => (toolCallId === "old-1" ? "omitted-node" : null),
          nodeText: () => null,
          retrievalAppendix: () =>
            Promise.resolve().then((): ModelMessage => {
              appendixCalls += 1;
              return { role: "assistant", content: "[Retrieval appendix]\n- node omitted-node" };
            }),
        };
        const compacted = yield* call(() =>
          compact(
            messages,
            { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
            sources,
            {
              compactAt: noLimit,
              leaveOutAt: noLimit,
            },
          ),
        );
        expect(appendixCalls).toBe(1);
        expect(compacted.messages.at(-2)).toEqual({
          role: "assistant",
          content: "[Retrieval appendix]\n- node omitted-node",
        });
        expect(compacted.messages.at(-1)).toEqual({ role: "user", content: "current question" });
        let intactCalls = 0;
        yield* call(() =>
          compact(
            [{ role: "user", content: "uncompacted" }],
            { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
            {
              ...sources,
              retrievalAppendix: () => Promise.resolve().then(() => ((intactCalls += 1), null)),
            },
            { compactAt: noLimit, leaveOutAt: noLimit },
          ),
        );
        expect(intactCalls).toBe(0);
        const fallback = yield* call(() =>
          compact(
            messages,
            { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
            {
              ...sources,
              retrievalAppendix: () => Promise.reject(new Error("search unavailable")),
            },
            { compactAt: noLimit, leaveOutAt: noLimit },
          ),
        );
        expect(fallback.messages.at(-1)).toEqual({ role: "user", content: "current question" });
      }),
  );

  it.live("keeps the provider request user-last when retrieval adds an appendix", () =>
    Effect.gen(function* () {
      const { runtime } = yield* call(() => testRuntime());
      const metadata = yield* Effect.provideContext(
        Effect.map(ChatState, (state) => state.persistence.stores.metadata),
        yield* runtime.contextEffect,
      );
      const messages: ModelMessage[] = [
        { role: "user", content: "earlier question" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "old-1",
              type: "function",
              function: { name: "run_shell", arguments: "{}" },
            },
          ],
        },
        { role: "tool", toolCallId: "old-1", content: "large earlier output" },
        { role: "assistant", content: "done" },
        { role: "user", content: "current question" },
      ];
      const sent = yield* firstSent(
        messages,
        compaction(
          metadata,
          {
            toolResultId: (toolCallId) => (toolCallId === "old-1" ? "omitted-node" : null),
            nodeText: () => null,
            retrievalAppendix: () =>
              Promise.resolve({
                role: "assistant" as const,
                content: "[Retrieval appendix]",
              }),
          },
          { compactAt: noLimit, leaveOutAt: noLimit },
        ),
      );
      expect(sent.at(-2)).toEqual({ role: "assistant", content: "[Retrieval appendix]" });
      expect(sent.at(-1)).toEqual({ role: "user", content: "current question" });
    }),
  );

  it.live(
    "/compact summarizes earlier turns and clears answered output for the runs that follow",
    () =>
      Effect.gen(function* () {
        const context = yield* call(() => testRuntime({ testProvider: {} }));
        const { runtime, project, session } = context;
        yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
        const { agent, nodes, stores } = yield* Effect.provideContext(
          Effect.all({
            agent: AgentChat,
            nodes: Nodes,
            stores: Effect.map(ChatState, (state) => state.persistence.stores),
          }),
          yield* runtime.contextEffect,
        );
        const { userNodes, messages, toolOutput, toolResult } = conversation(
          nodes,
          { projectId: project.id, sessionId: session.id },
          ["모두 통과했어요.", "네", "네", "네", "네"],
        );
        yield* call(() => stores.messages.saveThread(session.id, messages));
        const compact = Effect.fn("compaction.compact")(function* (holder: string | null) {
          const response = yield* Effect.provideContext(
            agent.compact(session.id, holder),
            yield* runtime.contextEffect,
          );
          return {
            status: response.status,
            body: yield* decodeCompact(yield* call(() => response.json())),
          };
        });
        yield* Effect.provideContext(
          agent.lease(session.id, "tab-a", "claim"),
          yield* runtime.contextEffect,
        );
        expect(
          (yield* Effect.provideContext(
            agent.compact(session.id, "tab-b"),
            yield* runtime.contextEffect,
          )).status,
        ).toBe(423);
        expect(
          (yield* Effect.provideContext(
            agent.compact("no-such-session", "tab-a"),
            yield* runtime.contextEffect,
          )).status,
        ).toBe(404);
        const first = yield* compact("tab-a");
        expect(first.status).toBe(200);
        // Explicit /compact is not gated by the old 25%-of-window threshold.
        expect(first.body.tokensBefore).toBeLessThan(258_400 * 0.25);
        // The latest two stay raw. Answered tool output is already pointerized by automatic compaction.
        expect(first.body).toMatchObject({ cleared: 0, summarizedTurns: 4, summaryFailed: false });
        expect(first.body.tokensAfter).toBeLessThan(first.body.tokensBefore);
        expect((yield* compact("tab-a")).body).toEqual({
          cleared: 0,
          summarizedTurns: 0,
          summaryFailed: false,
          tokensBefore: first.body.tokensAfter,
          tokensAfter: first.body.tokensAfter,
        });
        // The next question gets the summary, however small the conversation.
        const sent = yield* firstSent(
          [
            ...messages,
            { role: "assistant", content: "네" },
            { role: "user", content: "다음 질문" },
          ],
          compaction(stores.metadata, sourcesOf(nodes, session.id), {
            compactAt: noLimit,
            leaveOutAt: noLimit,
          }),
          session.id,
        );
        expect(sent[0]).toEqual({
          role: "assistant",
          content: expect.stringContaining(`- 사용자 턴 4개 (node ${userNodes[0]!.id})`),
        });
        expect(sent[1]).toEqual({ role: "user", content: "질문 5" });
        expect(yield* stringifyJson(sent)).not.toContain(toolResult.id);
        // The saved conversation still has everything.
        const kept = yield* call(() => stores.messages.loadThread(session.id));
        expect(kept.find((message) => message.role === "tool")?.content).toBe(toolOutput);
      }),
  );

  it.live(
    "/compact after automatic summary catch-up adds no reduction to the pilot's next request",
    () =>
      Effect.gen(function* () {
        const { runtime, project, session } = yield* call(() => testRuntime({ testProvider: {} }));
        yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
        const { agent, nodes, stores } = yield* Effect.provideContext(
          Effect.all({
            agent: AgentChat,
            nodes: Nodes,
            stores: Effect.map(ChatState, (state) => state.persistence.stores),
          }),
          yield* runtime.contextEffect,
        );
        const { userNodes, messages } = conversation(
          nodes,
          { projectId: project.id, sessionId: session.id },
          ["네", "네", "네", "네", "네"],
        );
        yield* call(() => stores.messages.saveThread(session.id, messages));
        // The pilot forces automatic catch-up before B's manual call: four older user turns
        // are already summarized and the two most recent user turns must stay raw.
        yield* call(() =>
          stores.metadata.set(turnSummariesNamespace, session.id, {
            blocks: [{ end: 4, nextTurnNodeId: userNodes[4]!.id, text: "- 결정 보존" }],
          }),
        );
        const sent = () =>
          firstSent(
            messages,
            compaction(stores.metadata, sourcesOf(nodes, session.id), budgetFor(200_000)),
            session.id,
          );
        const before = yield* sent();
        const response = yield* Effect.provideContext(
          agent.compact(session.id, null),
          yield* runtime.contextEffect,
        );
        expect(response.status).toBe(200);
        expect(yield* decodeCompact(yield* call(() => response.json()))).toMatchObject({
          cleared: 0,
          summarizedTurns: 0,
          summaryFailed: false,
        });
        expect(yield* sent()).toEqual(before);
      }),
  );

  it.live("reports prompt cache usage across consecutive requests and distinguishes zero", () =>
    Effect.gen(function* () {
      const setup = yield* call(() =>
        testRuntime({
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
        }),
      );
      const { runtime, session } = setup;
      yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
      const agent = yield* Effect.provideContext(AgentChat, yield* runtime.contextEffect);
      const status = Effect.fn("compaction.status")(function* () {
        const response = yield* Effect.provideContext(
          agent.status(session.id, null),
          yield* runtime.contextEffect,
        );
        const value = yield* call(() => response.json());
        return (yield* decodeStatus(value)).context;
      });
      const run = Effect.fn("compaction.run")(function* (runId: string) {
        const response = yield* Effect.provideContext(
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* stringifyJson({
                threadId: session.id,
                runId,
                messages: [{ id: `${runId}-message`, role: "user", content: "hello" }],
                tools: [],
                context: [],
              }),
            }),
            session.id,
          ),
          yield* runtime.contextEffect,
        );
        const events = yield* call(() => response.text());
        return yield* Effect.forEach(
          events.split("\n").filter((line) => line.startsWith("data: ")),
          (line) => Schema.decodeEffect(StreamEvent)(line.slice(6)),
        );
      });
      expect(yield* status()).toEqual({
        usedTokens: null,
        cachedTokens: null,
        cacheRatio: null,
        compactionStage: null,
        windowTokens: 200_000,
        compactAtTokens: 0,
      });
      const firstEvents = yield* run("run-1");
      expect(
        firstEvents.some(
          (event) => event.type === "CUSTOM" && event.name === "memory-agent.context",
        ),
      ).toBe(true);
      expect(yield* status()).toMatchObject({
        usedTokens: 120,
        cachedTokens: 30,
        cacheRatio: 0.25,
        compactionStage: "none",
      });
      yield* run("run-2");
      expect(yield* status()).toMatchObject({
        usedTokens: 120,
        cachedTokens: 0,
        cacheRatio: 0,
        compactionStage: "none",
      });
      const ledger = yield* Effect.provideContext(ApiUsage, yield* runtime.contextEffect);
      expect(ledger.byRootSession(session.id)).toMatchObject({
        responses: 2,
        inputTokens: 240,
        outputTokens: 10,
        cacheReadTokens: 30,
        uncachedInputTokens: 210,
      });
    }),
  );

  test("counts Korean closer to how models do than characters / 4", () => {
    expect(estimateTokens({ role: "user", content: "가나다abcd" })).toBe(4);
    expect(estimateTokens({ role: "user", content: "abcdefgh" })).toBe(2);
  });
});
