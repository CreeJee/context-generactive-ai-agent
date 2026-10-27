import { it } from "@effect/vitest";
// Stream fakes implement the subscription client contract.
import { Deferred, Effect, Logger, Option, References, Schema, Stream } from "effect";
import { Prompt } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import {
  subscriptionModel,
  publicReasoningLimits,
  subscriptionFailure,
  SubscriptionStreamFailed,
  SubscriptionStreamFailedReason,
  type StreamingOAuthClient,
} from "../../src/model/subscription.ts";
import {
  decodeProviderEvent,
  NormalizedStreamEvent,
  ProviderFeatureRejectedError,
  ProviderStreamFailed,
  ReasoningSummaryProtocolFailed,
  ReasoningSummaryProtocolFailedReason,
  RequestNotSent,
} from "../../src/oauth/protocol.ts";
import {
  OAuthHarnessError,
  type SubscriptionClientFailure,
} from "../../src/oauth/validation-harness.ts";
import type { SubscriptionAccountProvider } from "../../src/providers/contracts.ts";

/**
 * The subscription model's stream contract (docs/effect-ai-migration.md step 2): what it emits for
 * the provider's events, which failures its `AiError` carries, and what it never logs. The request
 * bodies are compared with TanStack's in requests.test.ts.
 */

const prompt = Prompt.make([
  { role: "system", content: "Follow the rules." },
  { role: "user", content: "private question" },
]);

/** A client that yields `events`, then fails with `failure` as the client would. */
const clientOf = (
  events: ReadonlyArray<NormalizedStreamEvent>,
  failure?: SubscriptionClientFailure,
): StreamingOAuthClient => ({
  stream: () =>
    Stream.concat(
      Stream.fromIterable(events, { chunkSize: 1 }),
      failure === undefined ? Stream.empty : Stream.fail(failure),
    ),
});

const modelOf = (provider: SubscriptionAccountProvider, client: StreamingOAuthClient) =>
  subscriptionModel({
    client,
    selection: { provider, model: "model-1", reasoningEffort: "medium" },
    promptCache: { retention: "short", key: "thread" },
  });

/** The parts the model streams, with tool calls left for the caller as the agent loop leaves them. */
const partsOf = Effect.fnUntraced(function* (
  provider: SubscriptionAccountProvider,
  client: StreamingOAuthClient,
) {
  const model = yield* modelOf(provider, client);
  return yield* Stream.runCollect(
    model.streamText({ prompt, disableToolCallResolution: true, toolCallValidation: "deferred" }),
  );
});

/** The subscription failure the stream fails with. */
const failureOf = (provider: SubscriptionAccountProvider, client: StreamingOAuthClient) =>
  Effect.map(Effect.flip(partsOf(provider, client)), subscriptionFailure);

const failed = (
  reason: SubscriptionStreamFailed["reason"],
  provider: SubscriptionAccountProvider = "openai",
) => Option.some(SubscriptionStreamFailed.make({ provider, reason }));
const summaryFailed = (reason: ReasoningSummaryProtocolFailed["reason"]) =>
  Option.some(ReasoningSummaryProtocolFailed.make({ reason }));
const resourceLimit = summaryFailed(
  ReasoningSummaryProtocolFailedReason.cases.ResourceLimit.make({}),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const start = NormalizedStreamEvent["reasoning-summary-start"]({
  id: "summary",
  summaryIndex: 0,
  text: "",
});
const end = NormalizedStreamEvent["reasoning-summary-end"]({
  id: "summary",
  summaryIndex: 0,
  text: "",
});

describe("subscription language model", () => {
  it.effect("streams OpenAI summaries, encrypted reasoning, tool calls and text in order", () =>
    Effect.gen(function* () {
      const wire = [
        {
          type: "response.reasoning_summary_part.added",
          item_id: "rs-1",
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs-1",
          output_index: 0,
          summary_index: 0,
          delta: "Checking",
        },
        {
          type: "response.reasoning_summary_part.done",
          item_id: "rs-1",
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: "Checking details." },
        },
        {
          type: "response.reasoning_summary_part.added",
          item_id: "rs-1",
          output_index: 0,
          summary_index: 1,
          part: { type: "summary_text", text: "Next step." },
        },
        {
          type: "response.reasoning_summary_part.done",
          item_id: "rs-1",
          output_index: 0,
          summary_index: 1,
          part: { type: "summary_text", text: "Next step." },
        },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs-1", encrypted_content: "encrypted-value" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "lookup",
            arguments: '{"query":"x"}',
          },
        },
        { type: "response.output_text.delta", delta: "Answer." },
      ];
      const events = wire.flatMap((event) => {
        const decoded = decodeProviderEvent("openai", JSON.stringify(event));
        return decoded === null ? [] : [decoded];
      });
      expect(events).toHaveLength(wire.length);
      const parts = yield* partsOf("openai", clientOf(events));
      expect(parts.map((part) => part.type)).toEqual([
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-end",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "tool-params-start",
        "tool-params-delta",
        "tool-params-end",
        "tool-call",
        "text-start",
        "text-delta",
        "text-end",
        "finish",
      ]);
      expect(
        parts.flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : [])),
      ).toEqual(["Checking", " details.", "Next step."]);
      // The encrypted reasoning signs the summary it follows, as TanStack stored it.
      expect(parts.filter((part) => part.type === "reasoning-end")).toMatchObject([
        { id: "reasoning-summary-rs-1-0", metadata: { "memory-agent": {} } },
        {
          id: "reasoning-summary-rs-1-1",
          metadata: { "memory-agent": { signature: expect.stringMatching(/^openai-reasoning:/) } },
        },
      ]);
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        id: "call-1",
        name: "lookup",
        params: { query: "x" },
      });
      expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" });
    }),
  );

  it.effect("ends Anthropic text at its content block end", () =>
    Effect.gen(function* () {
      const parts = yield* partsOf(
        "anthropic",
        clientOf([
          NormalizedStreamEvent.text({ text: "Which option?" }),
          NormalizedStreamEvent["content-block-end"]({ index: 0 }),
        ]),
      );
      expect(parts.map((part) => part.type)).toEqual([
        "text-start",
        "text-delta",
        "text-end",
        "finish",
      ]);
      expect(parts.at(-1)).toMatchObject({ reason: "stop" });
    }),
  );

  it.effect("streams tool arguments and reports usage with its cache reads", () =>
    Effect.gen(function* () {
      const parts = yield* partsOf(
        "anthropic",
        clientOf([
          NormalizedStreamEvent.usage({ promptTokens: 10, cachedPromptTokens: 4 }),
          NormalizedStreamEvent.text({ text: "hello" }),
          NormalizedStreamEvent["tool-call-start"]({ index: 1, id: "call-2", name: "nested" }),
          NormalizedStreamEvent["tool-call-arguments"]({
            index: 1,
            delta: '{"value":{"nested":true}}',
          }),
          NormalizedStreamEvent["content-block-end"]({ index: 1 }),
          NormalizedStreamEvent.usage({ completionTokens: 3 }),
        ]),
      );
      expect(parts.map((part) => part.type)).toEqual([
        "text-start",
        "text-delta",
        "text-end",
        "tool-params-start",
        "tool-params-delta",
        "tool-params-end",
        "tool-call",
        "finish",
      ]);
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        id: "call-2",
        params: { value: { nested: true } },
        // The arguments as the model sent them, which the next request sends back.
        metadata: { "memory-agent": { arguments: '{"value":{"nested":true}}' } },
      });
      expect(parts.at(-1)).toMatchObject({
        reason: "tool-calls",
        usage: {
          inputTokens: { total: 10, uncached: 6, cacheRead: 4 },
          outputTokens: { total: 3 },
        },
      });
    }),
  );

  it.effect("collects the stream into one response for generateText", () =>
    Effect.gen(function* () {
      const model = yield* modelOf(
        "anthropic",
        clientOf([
          NormalizedStreamEvent["reasoning-start"]({ index: 0 }),
          NormalizedStreamEvent["reasoning-delta"]({ index: 0, delta: "Think" }),
          NormalizedStreamEvent["reasoning-delta"]({ index: 0, delta: "ing." }),
          NormalizedStreamEvent["reasoning-signature"]({ index: 0, signature: "signed" }),
          NormalizedStreamEvent["content-block-end"]({ index: 0 }),
          NormalizedStreamEvent.text({ text: "Ans" }),
          NormalizedStreamEvent.text({ text: "wer." }),
        ]),
      );
      const response = yield* model.generateText({ prompt });
      expect(response.text).toBe("Answer.");
      expect(response.reasoningText).toBe("Thinking.");
      expect(response.finishReason).toBe("stop");
    }),
  );

  it.effect("refuses structured output", () =>
    Effect.gen(function* () {
      const model = yield* modelOf("openai", clientOf([]));
      const error = yield* Effect.flip(
        model.generateObject({ prompt, schema: Schema.Struct({ answer: Schema.String }) }),
      );
      expect(error.reason._tag).toBe("InvalidRequestError");
    }),
  );

  it.effect("sends the request once more without caching when Anthropic rejects the cache", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const client: StreamingOAuthClient = {
        stream: (body) => {
          bodies.push(body);
          return bodies.length === 1
            ? Stream.fail(
                ProviderFeatureRejectedError.make({
                  provider: "anthropic",
                  feature: "prompt-cache",
                  status: 400,
                }),
              )
            : Stream.make(NormalizedStreamEvent.text({ text: "fallback worked" }));
        },
      };
      const parts = yield* partsOf("anthropic", client);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain("cache_control");
      expect(bodies[1]).not.toContain("cache_control");
      expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))).toEqual([
        "fallback worked",
      ]);
    }),
  );

  it.effect("does not retry other provider failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client: StreamingOAuthClient = {
        stream: () => {
          attempts += 1;
          return Stream.make(
            NormalizedStreamEvent.error({ code: "overloaded_error", message: "busy" }),
          );
        },
      };
      expect(yield* failureOf("anthropic", client)).toEqual(
        failed(SubscriptionStreamFailedReason.cases.ProviderRejected.make({}), "anthropic"),
      );
      expect(attempts).toBe(1);
    }),
  );

  it.effect("classifies transport failures by delivery and stream position", () =>
    Effect.gen(function* () {
      const notSent = ProviderStreamFailed.make({
        provider: "openai",
        reason: RequestNotSent.make({ stage: "connect" }),
      });
      expect(yield* failureOf("openai", clientOf([], notSent))).toEqual(
        failed(SubscriptionStreamFailedReason.cases.RequestNotSent.make({ stage: "connect" })),
      );
      expect(
        yield* failureOf(
          "openai",
          clientOf(
            [NormalizedStreamEvent.text({ text: "partial" })],
            OAuthHarnessError.fromCode("transport_unavailable"),
          ),
        ),
      ).toEqual(failed(SubscriptionStreamFailedReason.cases.ResponseInterrupted.make({})));
      expect(
        yield* failureOf(
          "openai",
          clientOf([], OAuthHarnessError.fromCode("transport_unavailable")),
        ),
      ).toEqual(failed(SubscriptionStreamFailedReason.cases.RequestOutcomeUnknown.make({})));
    }),
  );

  it.effect("fails public summaries at their text, part and id limits", () =>
    Effect.gen(function* () {
      const tooLong = "x".repeat(publicReasoningLimits.characters + 1);
      expect(yield* failureOf("openai", clientOf([{ ...start, text: tooLong }]))).toEqual(
        resourceLimit,
      );
      expect(
        yield* failureOf(
          "openai",
          clientOf([
            start,
            NormalizedStreamEvent["reasoning-summary-delta"]({
              id: "summary",
              summaryIndex: 0,
              delta: tooLong,
            }),
          ]),
        ),
      ).toEqual(resourceLimit);
      expect(yield* failureOf("openai", clientOf([start, { ...end, text: tooLong }]))).toEqual(
        resourceLimit,
      );
      expect(
        yield* failureOf(
          "openai",
          clientOf([{ ...start, id: "x".repeat(publicReasoningLimits.idCharacters + 1) }]),
        ),
      ).toEqual(resourceLimit);
      const parts: NormalizedStreamEvent[] = [];
      for (let index = 0; index <= publicReasoningLimits.parts; index++)
        parts.push({ ...start, summaryIndex: index }, { ...end, summaryIndex: index });
      expect(yield* failureOf("openai", clientOf(parts))).toEqual(resourceLimit);
    }),
  );

  it.effect("fails conflicting, duplicate and late summaries", () =>
    Effect.gen(function* () {
      for (const events of [
        [start, start],
        [
          start,
          { ...end, text: "ok" },
          NormalizedStreamEvent["reasoning-summary-delta"]({
            id: "summary",
            summaryIndex: 0,
            delta: "late",
          }),
        ],
        [
          { ...start, text: "prefix" },
          { ...end, text: "different" },
        ],
      ] satisfies NormalizedStreamEvent[][]) {
        const failure = yield* failureOf("openai", clientOf(events));
        expect(Option.getOrUndefined(failure)).toBeInstanceOf(ReasoningSummaryProtocolFailed);
      }
    }),
  );

  it.effect("fails instead of finishing with an open summary, tool call or reasoning", () =>
    Effect.gen(function* () {
      expect(yield* failureOf("openai", clientOf([start]))).toEqual(
        summaryFailed(ReasoningSummaryProtocolFailedReason.cases.IncompleteSummary.make({})),
      );
      for (const event of [
        NormalizedStreamEvent["tool-call-start"]({ index: 0, id: "call", name: "fixture" }),
        NormalizedStreamEvent["reasoning-start"]({ index: 0 }),
      ])
        expect(yield* failureOf("openai", clientOf([event]))).toEqual(
          failed(SubscriptionStreamFailedReason.cases.IncompleteBlocks.make({})),
        );
    }),
  );

  it.effect("fails a block that would take over another tool call's index", () =>
    Effect.gen(function* () {
      expect(
        yield* failureOf(
          "openai",
          clientOf([
            NormalizedStreamEvent["tool-call-start"]({ index: 0, id: "first", name: "fixture" }),
            NormalizedStreamEvent["tool-call-start"]({ index: 0, id: "second", name: "fixture" }),
          ]),
        ),
      ).toEqual(failed(SubscriptionStreamFailedReason.cases.InvalidToolCall.make({})));
    }),
  );

  it.effect("keeps the provider's error text and the prompt out of errors and logs", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const capture = Logger.make((options) => {
        logs.push(Logger.formatStructured.log(options));
      });
      const error = yield* Effect.flip(
        partsOf(
          "openai",
          clientOf([
            NormalizedStreamEvent.error({ code: "secret-code", message: "secret-response" }),
          ]),
        ),
      ).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        Effect.provideService(References.MinimumLogLevel, "Trace"),
      );
      expect(Option.getOrUndefined(subscriptionFailure(error))).toBeInstanceOf(
        SubscriptionStreamFailed,
      );
      const written = yield* encodeJson([error, logs]);
      expect(written).not.toContain("secret");
      expect(written).not.toContain("private question");
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "ERROR",
          message: "subscription model request failed",
          annotations: { provider: "openai", code: "SubscriptionStreamFailed" },
        }),
      );
    }),
  );

  it.effect("interrupts the provider stream when the stream is interrupted", () =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<void>();
      const client: StreamingOAuthClient = {
        stream: () =>
          Stream.concat(Stream.make(start), Stream.never).pipe(
            Stream.ensuring(Deferred.succeed(ended, undefined)),
          ),
      };
      const model = yield* modelOf("openai", client);
      const parts = yield* Stream.runCollect(
        model
          .streamText({ prompt, disableToolCallResolution: true })
          .pipe(Stream.takeUntil((part) => part.type === "reasoning-start")),
      );
      expect(parts.map((part) => part.type)).toEqual(["reasoning-start"]);
      expect(yield* Deferred.isDone(ended)).toBe(true);
    }),
  );
});
