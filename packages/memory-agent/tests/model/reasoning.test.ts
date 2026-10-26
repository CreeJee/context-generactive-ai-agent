import { it } from "@effect/vitest";
// Native SDK boundary: TanStack's `chat()` stores the message it built from the same events.
import { chat, type ModelMessage } from "@tanstack/ai";
import { defineAIPersistence, defineMessageStore, withPersistence } from "@tanstack/ai-persistence";
import { Cause, Effect, Schema, Stream } from "effect";
import { Prompt } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import { StoredMessage } from "../../src/chat-store/schema.ts";
import { migrateMessage } from "../../src/chat-store/tanstack-migration.ts";
import type { JsonValue } from "../../src/json.ts";
import { fromPrompt } from "../../src/model/prompt.ts";
import { makeSubscriptionModel, type StreamingOAuthClient } from "../../src/model/subscription.ts";
import { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import type { SubscriptionModelSelection } from "../../src/providers/contracts.ts";
import { SubscriptionTextAdapter } from "../../src/providers/subscription-adapter.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";

/**
 * A response keeps the reasoning the next request needs, in the shape TanStack stored it: the
 * model's parts, made a prompt and then stored messages, hold the thinking and signatures that
 * TanStack's message for the same provider events held (docs/effect-ai-migration.md step 2).
 */

const clientOf = (events: ReadonlyArray<NormalizedStreamEvent>): StreamingOAuthClient => ({
  stream: () => nativeStream(Stream.fromIterable(events, { chunkSize: 1 })),
});

const decodeStored = Schema.decodeUnknownEffect(StoredMessage);
// The store holds the JSON text TanStack's messages serialize to.
const stored = (message: ModelMessage | undefined): JsonValue =>
  JSON.parse(JSON.stringify(message ?? null));

/** The assistant message TanStack stored for `events`, migrated. */
const tanstackMessage = Effect.fnUntraced(function* (
  selection: SubscriptionModelSelection,
  events: ReadonlyArray<NormalizedStreamEvent>,
) {
  let saved: ReadonlyArray<ModelMessage> = [];
  const persistence = defineAIPersistence({
    stores: {
      messages: defineMessageStore({
        loadThread: () => Promise.resolve(structuredClone([...saved])),
        saveThread: (_threadId, messages) => {
          saved = structuredClone(messages);
          return Promise.resolve();
        },
      }),
    },
  });
  yield* Stream.runDrain(
    Stream.fromAsyncIterable(
      chat({
        adapter: new SubscriptionTextAdapter(clientOf(events), selection),
        messages: [{ id: "user", role: "user", content: "Question." }],
        threadId: "thread",
        middleware: [withPersistence(persistence)],
      }),
      (cause) => new Cause.UnknownError(cause),
    ),
  );
  const assistant = saved.find((message) => message.role === "assistant");
  return yield* decodeStored(migrateMessage(stored(assistant)));
});

/** The assistant message the Effect AI model's response becomes, before the writer adds its fields. */
const effectMessage = Effect.fnUntraced(function* (
  selection: SubscriptionModelSelection,
  events: ReadonlyArray<NormalizedStreamEvent>,
) {
  const model = yield* makeSubscriptionModel({
    client: clientOf(events),
    selection,
    promptCache: undefined,
  });
  const response = yield* model.generateText({ prompt: "Question." });
  return fromPrompt(Prompt.fromResponseParts(response.content)).history;
});

/** What the provider needs back: the text, the thinking with its signatures, and the calls. */
const replayed = (message: StoredMessage | undefined) =>
  message?.role === "assistant"
    ? { content: message.content, thinking: message.thinking, toolCalls: message.toolCalls }
    : message;

const openai: SubscriptionModelSelection = {
  provider: "openai",
  model: "fixture",
  reasoningEffort: "medium",
};
const anthropic: SubscriptionModelSelection = {
  provider: "anthropic",
  model: "fixture",
  reasoningEffort: "medium",
};

const summary = (id: string, index: number, text: string) => [
  NormalizedStreamEvent["reasoning-summary-start"]({ id, summaryIndex: index, text: "" }),
  NormalizedStreamEvent["reasoning-summary-delta"]({ id, summaryIndex: index, delta: text }),
  NormalizedStreamEvent["reasoning-summary-end"]({ id, summaryIndex: index, text }),
];

const cases: ReadonlyArray<
  readonly [string, SubscriptionModelSelection, ReadonlyArray<NormalizedStreamEvent>]
> = [
  [
    "an OpenAI summary and its encrypted reasoning",
    openai,
    [
      ...summary("rs-1", 0, "Checking details"),
      NormalizedStreamEvent.reasoning({ id: "rs-1", encryptedContent: "opaque-do-not-display" }),
      NormalizedStreamEvent.text({ text: "Answer." }),
    ],
  ],
  [
    "OpenAI summaries in parts",
    openai,
    [
      ...summary("rs-1", 0, "First."),
      ...summary("rs-1", 1, "Second."),
      NormalizedStreamEvent.reasoning({ id: "rs-1", encryptedContent: "opaque" }),
      NormalizedStreamEvent.text({ text: "Answer." }),
    ],
  ],
  [
    "OpenAI encrypted reasoning without a summary",
    openai,
    [
      NormalizedStreamEvent.reasoning({ id: "rs-1", encryptedContent: "opaque" }),
      NormalizedStreamEvent.text({ text: "Answer." }),
    ],
  ],
  [
    "Anthropic thinking blocks and their signatures",
    anthropic,
    [
      NormalizedStreamEvent["reasoning-start"]({ index: 0 }),
      NormalizedStreamEvent["reasoning-delta"]({ index: 0, delta: "Think" }),
      NormalizedStreamEvent["reasoning-delta"]({ index: 0, delta: "ing." }),
      NormalizedStreamEvent["reasoning-signature"]({ index: 0, signature: "signed-1" }),
      NormalizedStreamEvent["content-block-end"]({ index: 0 }),
      NormalizedStreamEvent["reasoning-start"]({ index: 1 }),
      NormalizedStreamEvent["reasoning-delta"]({ index: 1, delta: "More." }),
      NormalizedStreamEvent["reasoning-signature"]({ index: 1, signature: "signed-2" }),
      NormalizedStreamEvent["content-block-end"]({ index: 1 }),
      NormalizedStreamEvent.text({ text: "Answer." }),
    ],
  ],
];

describe("subscription model reasoning", () => {
  it.effect("keeps what TanStack stored for the same provider events", () =>
    Effect.gen(function* () {
      for (const [name, selection, events] of cases) {
        const expected = replayed(yield* tanstackMessage(selection, events));
        const actual = yield* effectMessage(selection, events);
        expect(actual.map(replayed), name).toStrictEqual([expected]);
      }
    }),
  );

  it.effect("keeps encrypted reasoning out of the visible thinking", () =>
    Effect.gen(function* () {
      const [, selection, events] = cases[0]!;
      const [message] = yield* effectMessage(selection, events);
      expect(message?.role === "assistant" ? message.thinking : undefined).toEqual([
        { content: "Checking details", signature: expect.stringMatching(/^openai-reasoning:/) },
      ]);
      expect(message?.role === "assistant" ? message.content : undefined).not.toContain("opaque");
    }),
  );
});
