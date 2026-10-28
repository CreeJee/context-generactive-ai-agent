import { NodeCrypto } from "@effect/platform-node";
import { Crypto, Effect, Layer, MutableHashMap, MutableRef, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { modelHandoffNamespace } from "../src/agent/handoff-state.ts";
import {
  handoffNotice,
  ModelHandoffFailed,
  modelHandoffHistoryEffect,
  ModelHandoffReason,
} from "../src/agent/model-handoff.ts";
import { lookupSources } from "../src/agent/compaction.ts";
import { type ChatMetadata, ChatMetadataFailed } from "../src/chat-store/metadata.ts";
import type { StoredMessage } from "../src/chat-store/schema.ts";

function fixture(stored: ReadonlyArray<StoredMessage>) {
  const values = MutableHashMap.empty<string, unknown>();
  const metadata: ChatMetadata = {
    get: (namespace, key) =>
      Effect.sync(
        () => Option.getOrUndefined(MutableHashMap.get(values, `${namespace}:${key}`)) ?? null,
      ),
    set: (namespace, key, value) =>
      Effect.sync(() => {
        MutableHashMap.set(values, `${namespace}:${key}`, value);
      }),
  };
  const restore =
    (target: string, model: string, history = stored) =>
    (messages: ReadonlyArray<StoredMessage>) =>
      modelHandoffHistoryEffect({
        metadata,
        threadId: "session",
        target,
        model,
        provider: "openai-compatible",
        loadHistory: Effect.succeed(history),
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
/** The old model's answer as the store keeps it, with the model that wrote it. */
const oldAnswer = {
  role: "assistant" as const,
  content: null,
  thinking: [{ content: "private reasoning" }],
  toolCalls: [oldCall],
  model: "old-model",
};
const past: Array<StoredMessage> = [
  { role: "user", content: "프로젝트를 빌드해 줘" },
  oldAnswer,
  { role: "tool", toolCallId: "old-call", content: "build completed" },
];
const notice: StoredMessage = { role: "assistant", content: handoffNotice };
const pointer: StoredMessage = {
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

it.effect("stored messages name the model that wrote them", () =>
  Effect.gen(function* () {
    const stored: ReadonlyArray<StoredMessage> = [
      { role: "user", content: "프로젝트를 빌드해 줘" },
      { role: "assistant", content: "빌드했어", model: "old-model" },
    ];
    const restore = (model: string) =>
      modelHandoffHistoryEffect({
        metadata: fixture([]).metadata,
        threadId: "session",
        target: model,
        model,
        provider: "openai-compatible",
        loadHistory: Effect.succeed(stored),
        toolResultIds: () => Effect.succeed(new Map()),
      }).pipe(Effect.flatMap((restore) => restore(stored)));
    expect(yield* restore("old-model")).toBeNull();
    expect(yield* restore("new-model")).toEqual([
      notice,
      stored[0],
      { role: "assistant", content: "빌드했어" },
    ]);
  }),
);

it.effect("a retry/restart keeps the checkpoint and new-model tool iterations", () =>
  Effect.gen(function* () {
    const f = fixture(past);
    const question: StoredMessage = { role: "user", content: "continue" };
    const first = [...past, question];
    const restored = yield* f.restore("new", "new-model")(first);
    const newCall = { ...oldCall, id: "new-call" };
    const tail: Array<StoredMessage> = [
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
      )([
        past[0]!,
        past[1]!,
        { role: "tool", toolCallId: "old-call", content: "different result" },
      ]),
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

it.effect("a later turn keeps the handoff, and a changed boundary is refused", () =>
  Effect.gen(function* () {
    const stored: Array<StoredMessage> = past.map((message, index) => ({
      ...message,
      id: `message-${index}`,
    }));
    stored.push({
      role: "assistant",
      content: null,
      id: "boundary",
      thinking: [{ content: "reasoning" }],
    });
    const f = fixture(stored);
    yield* f.restore("new", "new-model")(stored);
    const tail: StoredMessage = { role: "user", content: "continue", id: "next" };
    const later = [...stored, tail];
    const restored = yield* f.restore("new", "new-model")(later);
    expect(restored).toEqual([notice, later[0], pointer, tail]);
    const changed = later.map((message) =>
      message.id === "boundary" ? { ...message, content: "changed" } : message,
    );
    const failed = yield* Effect.flip(f.restore("new", "new-model")(changed));
    expect(ModelHandoffReason.guards.HistoryChanged(failed.reason)).toBe(true);
  }),
);

it.effect("migrates a verified legacy boundary before replaying the stored history", () =>
  Effect.gen(function* () {
    const stored: Array<StoredMessage> = past.map((message, index) => ({
      ...message,
      id: `message-${index}`,
    }));
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
    yield* f.metadata.set(modelHandoffNamespace, "session", {
      _tag: "handoff",
      target: "new",
      through: stored.length,
      anchor: legacyAnchor,
      context: "legacy evidence",
    });
    expect(yield* f.restore("new", "new-model")(stored)).toEqual([notice, stored[0], pointer]);
    expect(yield* f.metadata.get(modelHandoffNamespace, "session")).toMatchObject({
      anchorId: "message-2",
      anchor: expect.stringMatching(/^v2:/),
    });
  }),
);

it.effect(
  "metadata failures stay typed and one preparation is shared across concurrent requests",
  () =>
    Effect.gen(function* () {
      const reads = MutableRef.make(0);
      const cause = new Error("private metadata details");
      const restore = yield* modelHandoffHistoryEffect({
        metadata: {
          get: () =>
            Effect.andThen(
              Effect.sync(() => {
                MutableRef.increment(reads);
              }),
              Effect.fail(ChatMetadataFailed.make({ cause })),
            ),
          set: () => Effect.void,
        },
        threadId: "session",
        target: "new",
        model: "new-model",
        provider: "openai-compatible",
        loadHistory: Effect.succeed(past),
        toolResultIds: () => Effect.succeed(new Map()),
      });
      const failures = yield* Effect.all([Effect.flip(restore(past)), Effect.flip(restore(past))], {
        concurrency: "unbounded",
      });
      expect(MutableRef.get(reads)).toBe(1);
      failures.forEach((failure) => {
        expect(failure).toBeInstanceOf(ModelHandoffFailed);
        expect(ModelHandoffReason.guards.ReadStateFailed(failure.reason)).toBe(true);
        expect(failure.cause).toBe(cause);
        expect(failure.message).not.toContain("private metadata");
      });
    }),
);
