import {
  type AdapterYieldChunk,
  EventType,
  createCapability,
  defineInterrupt,
  toolDefinition,
} from "@tanstack/ai";
import { expect, test } from "vite-plus/test";
import {
  createFullLoopExecution,
  preflightFullLoopExecution,
} from "../src/agent/full-loop-execution.ts";
import { encodeFullLoopValue, decodeFullLoopValue } from "../src/agent/full-loop-codec.ts";
import { makeInMemoryOwnerRpcLedger } from "../src/agent/owner-rpc.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";

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

test("owner finalization retains worker reasoning separately from the answer", async () => {
  class ReasoningAdapter extends ScriptedTextAdapter {
    override async *chatStream(
      options: Parameters<ScriptedTextAdapter["chatStream"]>[0],
    ): AsyncIterable<AdapterYieldChunk> {
      yield {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "thinking",
        model: options.model,
        role: "reasoning" as const,
        timestamp: 1,
      };
      yield {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "thinking",
        model: options.model,
        delta: "Compare the values.",
        timestamp: 2,
      };
      yield {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "thinking",
        model: options.model,
        timestamp: 3,
      };
      yield* super.chatStream(options);
    }
  }
  let finalized = false;
  for await (const _chunk of createFullLoopExecution<ReasoningAdapter>({
    capability,
    ledger: makeInMemoryOwnerRpcLedger(),
    permits: () => true,
    permitsFinalization: () => true,
    finalizationMiddleware: ["record-reasoning"],
    lastOperationId: 0,
  }).execute(
    { messages: [], runId: "r", threadId: "s" },
    {
      model: { adapter: new ReasoningAdapter([{ text: "The answer is 42." }]) },
      tools: [],
      stream: { abortController: new AbortController() },
      middleware: [
        {
          name: "record-reasoning",
          onFinish: (ctx) => {
            expect(ctx.messages).toContainEqual(
              expect.objectContaining({
                role: "assistant",
                thinking: [{ content: "Compare the values." }],
              }),
            );
            expect(ctx.accumulatedContent).toBe("The answer is 42.");
            finalized = true;
          },
        },
      ],
    },
  )) {
    /* consume */
  }
  expect(finalized).toBe(true);
});

test("tagged codec retains Maps, Sets, undefined and errors without tag collisions", () => {
  const original = {
    map: new Map([["approval", true]]),
    set: new Set(["cancelled"]),
    absent: undefined,
    error: new Error("provider failed"),
    tagCollision: ["map", []],
  };
  const decoded = decodeFullLoopValue(encodeFullLoopValue(original));
  expect(decoded).toMatchObject({
    ...original,
    error: expect.objectContaining({ name: "Error", message: "provider failed" }),
  });
  expect(() => decodeFullLoopValue(["bad-tag"])).toThrow("Invalid worker value tag");
  expect(() => encodeFullLoopValue(Infinity)).toThrow("Non-finite");
});

test("worker hooks preserve owner context identity and SDK capability WeakMaps", async () => {
  const handle = createCapability<{ count: number }>()("test-count");
  const [getCount, provideCount] = handle;
  const states = new WeakSet<object>();
  let finished = 0;
  const adapter = new ScriptedTextAdapter([{ text: "context preserved" }]);
  const capabilities = {
    model: { adapter },
    tools: [],
    stream: { abortController: new AbortController() },
    middleware: [
      {
        name: "provider",
        provides: [handle],
        setup: (ctx: import("@tanstack/ai").ChatMiddlewareContext) => {
          states.add(ctx);
          provideCount(ctx, { count: 0 });
        },
      },
      {
        name: "consumer",
        requires: [handle],
        onConfig: (ctx: import("@tanstack/ai").ChatMiddlewareContext) => {
          expect(states.has(ctx)).toBe(true);
          getCount(ctx).count++;
          return {
            resumeToolState: { approvals: new Map(), cancelledToolCallIds: new Set<string>() },
          };
        },
        onFinish: (ctx: import("@tanstack/ai").ChatMiddlewareContext) => {
          expect(states.has(ctx)).toBe(true);
          expect(getCount(ctx).count).toBeGreaterThan(0);
          finished++;
        },
      },
    ],
  };
  preflightFullLoopExecution({ messages: [], runId: "r", threadId: "s" }, capabilities);
  const chunks = [];
  for await (const chunk of createFullLoopExecution<ScriptedTextAdapter>({
    capability,
    ledger: makeInMemoryOwnerRpcLedger(),
    permits: () => true,
    permitsFinalization: () => true,
    finalizationMiddleware: ["provider", "consumer", "owner-gate"],
    lastOperationId: 0,
  }).execute({ messages: [], runId: "r", threadId: "s" }, capabilities))
    chunks.push(chunk);
  expect(finished).toBe(1);
  expect(chunks.some((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
}, 20000);

test("worker reconstructs owner-issued generic interruption without executing the gated tool", async () => {
  const definition = defineInterrupt({
    id: "owner-review",
    responseSchema: {
      "~standard": {
        version: 1,
        vendor: "test",
        jsonSchema: { input: () => ({ type: "object" }), output: () => ({ type: "object" }) },
      },
    },
  });
  const adapter = new ScriptedTextAdapter([
    { toolCalls: [{ id: "call", name: "gated", arguments: "{}" }] },
  ]);
  let calls = 0;
  const tool = toolDefinition({ name: "gated", description: "gated owner tool" }).server(() => {
    calls++;
    return "must not run";
  });
  const chunks = [];
  for await (const chunk of createFullLoopExecution<ScriptedTextAdapter>({
    capability,
    ledger: makeInMemoryOwnerRpcLedger(),
    permits: () => true,
    permitsFinalization: () => true,
    finalizationMiddleware: ["provider", "consumer", "owner-gate"],
    lastOperationId: 0,
  }).execute(
    { messages: [], runId: "r", threadId: "s", interrupts: [definition] },
    {
      model: { adapter },
      tools: [tool],
      middleware: [
        {
          name: "owner-gate",
          onInterruptBoundary: (ctx) =>
            ctx.phase === "beforeTools"
              ? {
                  interrupts: [
                    definition.interrupt({
                      key: "call",
                      reason: "review",
                      message: "Owner approval required",
                    }),
                  ],
                }
              : undefined,
        },
      ],
      stream: { abortController: new AbortController() },
    },
  ))
    chunks.push(chunk);
  expect(calls).toBe(0);
  expect(chunks.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true);
  expect(JSON.stringify(chunks)).toContain("Owner approval required");
}, 20000);

test("owner finalization records after terminal persistence and revokes at teardown", async () => {
  let active = true;
  let issued = true;
  let recorded = 0;
  let deferred = 0;
  const adapter = new ScriptedTextAdapter([{ text: "persist me" }]);
  const chunks = [];
  for await (const chunk of createFullLoopExecution<ScriptedTextAdapter>({
    capability,
    ledger: makeInMemoryOwnerRpcLedger(),
    permits: () => issued && active,
    permitsFinalization: () => issued,
    finalizationMiddleware: ["terminal-persistence", "recorder"],
    revoke: () => {
      issued = false;
    },
    lastOperationId: 0,
  }).execute(
    { messages: [], runId: "r", threadId: "s" },
    {
      model: { adapter },
      tools: [],
      stream: { abortController: new AbortController() },
      middleware: [
        {
          name: "terminal-persistence",
          onFinish: () => {
            active = false;
          },
        },
        {
          name: "recorder",
          onFinish: (ctx) => {
            expect(active).toBe(false);
            expect(ctx.accumulatedContent).toBe("persist me");
            recorded++;
            ctx.defer(
              Promise.resolve().then(() => {
                deferred++;
              }),
            );
          },
        },
      ],
    },
  ))
    chunks.push(chunk);
  expect(recorded).toBe(1);
  expect(deferred).toBe(1);
  expect(issued).toBe(false);
  expect(chunks.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true);
}, 20000);

test("preflight rejects unsupported continuation before dispatching any owner capability", () => {
  const adapter = new ScriptedTextAdapter([{ text: "must not run" }]);
  expect(() =>
    preflightFullLoopExecution(
      {
        messages: [],
        resume: [{ interruptId: "approval", status: "resolved", payload: { approved: true } }],
      },
      {
        model: { adapter },
        tools: [],
        middleware: [],
        stream: { abortController: new AbortController() },
      },
    ),
  ).toThrow("continuation");
  expect(adapter.invocations).toHaveLength(0);
});
