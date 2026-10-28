import { Effect, Stream } from "effect";
import {
  shownSubscriptionFailure,
  subscriptionModel,
  type StreamingOAuthClient,
} from "../../src/model/subscription.ts";
import { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import type { SubscriptionAccountProvider } from "../../src/providers/contracts.ts";
import { testAgent } from "../support/test-env.ts";
import { conversation, expectGolden } from "./driver.ts";

/**
 * Reasoning is stored by the provider's own adapter: Anthropic keeps the thinking signature,
 * OpenAI keeps its encrypted reasoning behind the `openai-reasoning:` prefix. The provider's events
 * are scripted; the model thinks and reads a file, then thinks and answers.
 */

const readCall = "golden-reasoning-read";

const usage = NormalizedStreamEvent.usage({
  promptTokens: 1_200,
  completionTokens: 30,
  cachedPromptTokens: 1_000,
});

const turns = {
  anthropic: (afterRead: boolean) => [
    NormalizedStreamEvent["reasoning-start"]({ index: 0 }),
    NormalizedStreamEvent["reasoning-delta"]({
      index: 0,
      delta: afterRead ? "The notes have two lines." : "I should read the notes.",
    }),
    NormalizedStreamEvent["reasoning-signature"]({
      index: 0,
      signature: afterRead ? "signed-answer" : "signed-read",
    }),
    NormalizedStreamEvent["content-block-end"]({ index: 0 }),
    ...(afterRead
      ? [NormalizedStreamEvent.text({ text: "The notes have two lines." })]
      : [
          NormalizedStreamEvent["tool-call-start"]({ index: 1, id: readCall, name: "read_file" }),
          NormalizedStreamEvent["tool-call-arguments"]({
            index: 1,
            delta: JSON.stringify({ path: "notes.txt" }),
          }),
          NormalizedStreamEvent["content-block-end"]({ index: 1 }),
        ]),
    usage,
  ],
  openai: (afterRead: boolean) => {
    const id = afterRead ? "rs-answer" : "rs-read";
    const summary = afterRead ? "The notes have two lines." : "I should read the notes.";
    return [
      NormalizedStreamEvent["reasoning-summary-start"]({ id, summaryIndex: 0, text: "" }),
      NormalizedStreamEvent["reasoning-summary-delta"]({ id, summaryIndex: 0, delta: summary }),
      NormalizedStreamEvent["reasoning-summary-end"]({ id, summaryIndex: 0, text: summary }),
      NormalizedStreamEvent.reasoning({ id, encryptedContent: `encrypted-${id}` }),
      afterRead
        ? NormalizedStreamEvent.text({ text: "The notes have two lines." })
        : NormalizedStreamEvent["tool-call"]({
            id: readCall,
            name: "read_file",
            arguments: { path: "notes.txt" },
          }),
      usage,
    ];
  },
} satisfies {
  readonly [provider in SubscriptionAccountProvider]: (
    afterRead: boolean,
  ) => ReadonlyArray<NormalizedStreamEvent>;
};

/** The request after the read carries the read call, so the model answers. */
const scriptedClient = (provider: SubscriptionAccountProvider): StreamingOAuthClient => ({
  stream: (body) => {
    const events: ReadonlyArray<NormalizedStreamEvent> = turns[provider](body.includes(readCall));
    return Stream.fromIterable(events, { chunkSize: 1 });
  },
});

(["anthropic", "openai"] as const).forEach((provider) => {
  testAgent({
    testProvider: {
      // As the provider's runtime makes it, on the scripted client.
      runModel: (selection, run) =>
        Effect.map(
          subscriptionModel({
            client: scriptedClient(provider),
            selection: { ...selection, provider },
            promptCache: { retention: run.cacheRetention, key: run.threadId },
          }),
          (model) => ({
            model,
            source: { provider, api: "text", model: selection.model },
            shownFailure: shownSubscriptionFailure,
          }),
        ),
    },
  })(`golden reasoning rows (${provider})`, (it) => {
    it.effect(
      "thinking before a tool call and before the answer",
      () =>
        Effect.gen(function* () {
          const chat = yield* conversation("ask");
          yield* chat.send("read the notes");
          yield* expectGolden(chat.sessionId, `reasoning-${provider}`);
        }),
      20_000,
    );
  });
});
