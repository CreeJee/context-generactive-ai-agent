import { it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Prompt } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import { StoredMessage } from "../../src/chat-store/schema.ts";
import { fromPrompt } from "../../src/model/prompt.ts";
import { subscriptionModel, type StreamingOAuthClient } from "../../src/model/subscription.ts";
import { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import type { SubscriptionModelSelection } from "../../src/providers/contracts.ts";

/**
 * A response keeps the reasoning the next request needs, in the shape TanStack stored it: the
 * model's parts, made a prompt and then stored messages, hold the thinking and signatures that
 * TanStack's message for the same provider events held (docs/effect-ai-migration.md step 2). The
 * golden file keeps the messages the comparison with TanStack proved equal.
 */

const clientOf = (events: ReadonlyArray<NormalizedStreamEvent>): StreamingOAuthClient => ({
  stream: () => Stream.fromIterable(events, { chunkSize: 1 }),
});

/** The assistant message the Effect AI model's response becomes, before the writer adds its fields. */
const effectMessage = Effect.fnUntraced(function* (
  selection: SubscriptionModelSelection,
  events: ReadonlyArray<NormalizedStreamEvent>,
) {
  const model = yield* subscriptionModel({
    client: clientOf(events),
    selection,
    promptCache: undefined,
  });
  const response = yield* model.generateText({ prompt: "Question." });
  return fromPrompt(Prompt.fromResponseParts(response.content)).history;
});

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

const encodeGolden = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String, history: Schema.Array(StoredMessage) })),
    { space: 2 },
  ),
);

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
    Effect.forEach(cases, ([name, selection, events]) =>
      Effect.map(effectMessage(selection, events), (history) => ({ name, history })),
    ).pipe(
      Effect.flatMap(encodeGolden),
      Effect.flatMap((text) =>
        Effect.promise(() =>
          expect(`${text}\n`).toMatchFileSnapshot("./__golden__/reasoning.json"),
        ),
      ),
    ),
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
