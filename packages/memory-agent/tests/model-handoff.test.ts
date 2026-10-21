import { NodeCrypto } from "@effect/platform-node";
import { Crypto, Effect, Layer, MutableHashMap, Option, Schema } from "effect";
import {
  convertMessagesToModelMessages,
  modelMessagesToUIMessages,
  type MetadataStore,
  type ModelMessage,
} from "@tanstack/ai";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  handoffNotice,
  ModelHandoffFailed,
  modelHandoffHistoryEffect,
  modelHandoffNamespace,
  ModelHandoffReason,
} from "../src/agent/model-handoff.ts";
import { lookupSources } from "../src/agent/compaction.ts";

function fixture(stored: readonly ModelMessage[]) {
  const values = MutableHashMap.empty<string, unknown>();
  const metadata: MetadataStore = {
    get: (namespace, key) =>
      Promise.resolve(
        Option.getOrUndefined(MutableHashMap.get(values, `${namespace}:${key}`)) ?? null,
      ),
    set: (namespace, key, value) => {
      MutableHashMap.set(values, `${namespace}:${key}`, value);
      return Promise.resolve();
    },
    delete: (namespace, key) => {
      MutableHashMap.remove(values, `${namespace}:${key}`);
      return Promise.resolve();
    },
  };
  const restore =
    (target: string, model: string, history = stored) =>
    (messages: readonly ModelMessage[]) =>
      modelHandoffHistoryEffect({
        metadata,
        threadId: "session",
        target,
        model,
        provider: "openai-compatible",
        loadHistory: () => Promise.resolve(history),
        toolResultIds: lookupSources({
          toolResultId: (toolCallId) => (toolCallId === "old-call" ? "old-result" : null),
          nodeText: () => null,
        }).toolResultIds,
      }).pipe(Effect.flatMap((restore) => restore(messages)));
  return { restore, metadata };
}

const oldCall = {
  id: "old-call",
  type: "function" as const,
  function: { name: "run_shell", arguments: '{"command":"build"}' },
};
const past: ModelMessage[] = [
  { role: "user", content: "프로젝트를 빌드해 줘" },
  {
    role: "assistant",
    content: null,
    thinking: [{ content: "private reasoning" }],
    toolCalls: [oldCall],
    metadata: { tanstack: { model: "old-model" } },
  },
  { role: "tool", toolCallId: "old-call", content: "build completed" },
];
const notice: ModelMessage = { role: "assistant", content: handoffNotice };
const pointer: ModelMessage = {
  role: "assistant",
  content:
    "[Earlier tool call run_shell. Its output is kept in memory as node old-result: call read_evidence with that id to read it.]",
};

it.effect("a new model gets the earlier turns as text and pointers, not the old protocol", () =>
  Effect.gen(function* () {
    const f = fixture(past);
    const input = [...past, { role: "user" as const, content: "이어서해줘" }];
    const original = structuredClone(input);
    const restored = yield* f.restore("provider:new-model", "new-model")(input);
    expect(restored).toEqual([notice, past[0], pointer, input.at(-1)]);
    expect(input).toEqual(original);
  }),
);

it.effect("a retry/restart keeps the checkpoint and new-model tool iterations", () =>
  Effect.gen(function* () {
    const f = fixture(past);
    const question: ModelMessage = { role: "user", content: "continue" };
    const first = [...past, question];
    const restored = yield* f.restore("new", "new-model")(first);
    const newCall = { ...oldCall, id: "new-call" };
    const tail: ModelMessage[] = [
      question,
      { role: "assistant", content: null, toolCalls: [newCall] },
      { role: "tool", toolCallId: "new-call", content: "new result" },
    ];
    const retried = yield* f.restore("new", "new-model", [...past, ...tail])([...past, ...tail]);
    expect(retried?.slice(0, 3)).toEqual(restored?.slice(0, 3));
    expect(retried?.slice(3)).toEqual(tail);
  }),
);

it.effect(
  "same target preserves history; switching endpoints with the same model restores context",
  () =>
    Effect.gen(function* () {
      const f = fixture(past);
      expect(yield* f.restore("endpoint-a", "old-model")(past)).toBeNull();
      expect(yield* f.restore("endpoint-a", "old-model")(past)).toBeNull();
      expect(yield* f.restore("endpoint-b", "old-model")(past)).toEqual([notice, past[0], pointer]);
    }),
);

it.effect(
  "pairs an approved old call completed during the new run without replaying other calls",
  () =>
    Effect.gen(function* () {
      const pending = past.slice(0, 2);
      const f = fixture(pending);
      const result = past[2]!;
      const restored = yield* f.restore("new", "new-model")([...pending, result]);
      expect(restored).toEqual([
        notice,
        past[0],
        { role: "assistant", content: null, toolCalls: [oldCall] },
        result,
      ]);
    }),
);

it.effect("rejects an invalidated boundary instead of dropping unrelated history", () =>
  Effect.gen(function* () {
    const f = fixture(past);
    yield* f.restore("new", "new-model")(past);
    const failed = yield* Effect.flip(
      f.restore(
        "new",
        "new-model",
      )([past[0]!, past[1]!, { role: "tool", content: "different result" }]),
    );
    expect(ModelHandoffReason.guards.HistoryChanged(failed.reason)).toBe(true);
  }),
);

it.effect("does not invent a user request for an assistant-only legacy thread", () =>
  Effect.gen(function* () {
    const history = past.slice(1);
    const f = fixture(history);
    const failed = yield* Effect.flip(f.restore("new", "new-model")(history));
    expect(ModelHandoffReason.guards.UserQuestionMissing(failed.reason)).toBe(true);
  }),
);

it.effect("UI hydration preserves a handoff across tool fan-out and field reordering", () =>
  Effect.gen(function* () {
    const stored = past.map((message, index) => ({ ...message, id: `message-${index}` }));
    stored.push({
      role: "assistant",
      content: null,
      id: "boundary",
      thinking: [{ content: "reasoning" }],
    });
    const f = fixture(stored);
    yield* f.restore("new", "new-model")(stored);
    const tail: ModelMessage = { role: "user", content: "continue", id: "next" };
    const hydrated = convertMessagesToModelMessages(modelMessagesToUIMessages([...stored, tail]));
    const restored = yield* f.restore("new", "new-model")(hydrated);
    expect(restored).toEqual([notice, hydrated[0], pointer, hydrated.at(-1)]);
    const changed = hydrated.map((message) =>
      message.id === "boundary" ? { ...message, content: "changed" } : message,
    );
    const failed = yield* Effect.flip(f.restore("new", "new-model")(changed));
    expect(ModelHandoffReason.guards.HistoryChanged(failed.reason)).toBe(true);
  }),
);

it.effect("migrates a verified legacy boundary before replaying hydrated history", () =>
  Effect.gen(function* () {
    const stored = past.map((message, index) => ({ ...message, id: `message-${index}` }));
    const f = fixture(stored);
    const legacyBoundary = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      stored.at(-1),
    );
    const crypto = yield* Crypto.Crypto.pipe(
      Effect.provideContext(yield* Layer.build(NodeCrypto.layer)),
    );
    const legacyAnchor = Buffer.from(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(legacyBoundary)),
    ).toString("hex");
    yield* Effect.promise(() =>
      f.metadata.set(modelHandoffNamespace, "session", {
        _tag: "handoff",
        target: "new",
        through: stored.length,
        anchor: legacyAnchor,
        context: "legacy evidence",
      }),
    );
    const hydrated = convertMessagesToModelMessages(modelMessagesToUIMessages(stored));
    expect(yield* f.restore("new", "new-model")(hydrated)).toEqual([notice, hydrated[0], pointer]);
    expect(
      yield* Effect.promise(() => f.metadata.get(modelHandoffNamespace, "session")),
    ).toMatchObject({
      anchorId: "message-2",
      anchor: expect.stringMatching(/^v2:/),
    });
  }),
);

it.effect(
  "metadata failures stay typed and one preparation is shared across concurrent requests",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const cause = new Error("private metadata details");
      const restore = yield* modelHandoffHistoryEffect({
        metadata: {
          get: () => {
            reads += 1;
            return Promise.reject(cause);
          },
          set: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        },
        threadId: "session",
        target: "new",
        model: "new-model",
        provider: "openai-compatible",
        loadHistory: () => Promise.resolve(past),
        toolResultIds: () => Effect.succeed(new Map()),
      });
      const failures = yield* Effect.all([Effect.flip(restore(past)), Effect.flip(restore(past))], {
        concurrency: "unbounded",
      });
      expect(reads).toBe(1);
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(ModelHandoffFailed);
        expect(ModelHandoffReason.guards.ReadStateFailed(failure.reason)).toBe(true);
        expect(failure.cause).toBe(cause);
        expect(failure.message).not.toContain("private metadata");
      }
    }),
);
