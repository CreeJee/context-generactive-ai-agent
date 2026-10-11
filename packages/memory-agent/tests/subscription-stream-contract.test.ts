import { Cause } from "effect";
import { Result, Schema } from "effect";
import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { Effect, Stream } from "effect";
import { nativeStream } from "../src/runtime/native-stream.ts";
// Native SDK async-iterator boundary; fixtures do not contact providers or execute tools.
import { EventType } from "@tanstack/ai";
import { InternalLogger } from "@tanstack/ai/adapter-internals";
import { expect, test, vi } from "vite-plus/test";
import {
  ReasoningSummaryProtocolFailed,
  type NormalizedStreamEvent,
} from "../src/oauth/protocol.ts";
import {
  SubscriptionTextAdapter,
  SubscriptionStreamFailed,
  publicReasoningLimits,
} from "../src/providers/subscription-adapter.ts";

const logger = new InternalLogger(
  { debug() {}, info() {}, warn() {}, error() {} },
  {
    request: false,
    provider: false,
    output: false,
    middleware: false,
    tools: false,
    agentLoop: false,
    config: false,
    errors: true,
    sandbox: false,
  },
);
const start: NormalizedStreamEvent = {
  type: "reasoning-summary-start",
  id: "summary",
  summaryIndex: 0,
  text: "",
};
const end: NormalizedStreamEvent = {
  type: "reasoning-summary-end",
  id: "summary",
  summaryIndex: 0,
  text: "",
};
const collect = (events: readonly NormalizedStreamEvent[]) => {
  const adapter = new SubscriptionTextAdapter(
    {
      stream() {
        return nativeStream(
          Stream.fromIterable(
            (function* () {
              yield* events;
            })(),
            { chunkSize: 1 },
          ),
        );
      },
    },
    { provider: "openai", model: "fixture", reasoningEffort: "medium" },
  );
  return runNativeEffect(
    Stream.runCollect(
      Stream.fromAsyncIterable(
        adapter.chatStream({
          model: "fixture",
          messages: [],
          logger,
        }),
        (cause) => new Cause.UnknownError(cause),
      ),
    ),
  );
};

test("public summaries fail explicitly at text/part/id limits rather than retaining unbounded state", () =>
  runNativeEffect(
    Effect.gen(function* () {
      yield* nativePromise(() =>
        expect(
          collect([{ ...start, text: "x".repeat(publicReasoningLimits.characters + 1) }]),
        ).rejects.toMatchObject({
          _tag: "ReasoningSummaryProtocolFailed",
          reason: { _tag: "ResourceLimit" },
        }),
      );
      yield* nativePromise(() =>
        expect(
          collect([
            start,
            {
              type: "reasoning-summary-delta",
              id: "summary",
              summaryIndex: 0,
              delta: "x".repeat(publicReasoningLimits.characters + 1),
            },
          ]),
        ).rejects.toBeInstanceOf(ReasoningSummaryProtocolFailed),
      );
      yield* nativePromise(() =>
        expect(
          collect([start, { ...end, text: "x".repeat(publicReasoningLimits.characters + 1) }]),
        ).rejects.toMatchObject({ reason: { _tag: "ResourceLimit" } }),
      );
      yield* nativePromise(() =>
        expect(
          collect([{ ...start, id: "x".repeat(publicReasoningLimits.idCharacters + 1) }]),
        ).rejects.toMatchObject({ reason: { _tag: "ResourceLimit" } }),
      );
      const parts: NormalizedStreamEvent[] = [];
      for (let index = 0; index <= publicReasoningLimits.parts; index++)
        parts.push({ ...start, summaryIndex: index }, { ...end, summaryIndex: index });
      yield* nativePromise(() =>
        expect(collect(parts)).rejects.toMatchObject({ reason: { _tag: "ResourceLimit" } }),
      );
    }),
  ));

test("conflicting, duplicate and post-end summaries preserve safe typed failures", () =>
  runNativeEffect(
    Effect.gen(function* () {
      for (const events of [
        [start, start],
        [
          start,
          { ...end, text: "ok" },
          { type: "reasoning-summary-delta", id: "summary", summaryIndex: 0, delta: "late" },
        ],
        [
          { ...start, text: "prefix" },
          { ...end, text: "different" },
        ],
      ] satisfies NormalizedStreamEvent[][])
        yield* nativePromise(() =>
          expect(collect(events)).rejects.toBeInstanceOf(ReasoningSummaryProtocolFailed),
        );
    }),
  ));

test("clean exhaustion with open summary/tool/reasoning cannot report RUN_FINISHED", () =>
  runNativeEffect(
    Effect.gen(function* () {
      yield* nativePromise(() =>
        expect(collect([start])).rejects.toMatchObject({ reason: { _tag: "IncompleteSummary" } }),
      );
      for (const event of [
        { type: "tool-call-start", index: 0, id: "call", name: "fixture" },
        { type: "reasoning-start", index: 0 },
      ] satisfies NormalizedStreamEvent[])
        yield* nativePromise(() =>
          expect(collect([event])).rejects.toMatchObject({
            _tag: "SubscriptionStreamFailed",
            reason: { _tag: "IncompleteBlocks" },
          }),
        );
    }),
  ));

test("provider-controlled error contents never become thrown error or error log metadata", () => {
  const log = vi.spyOn(logger, "errors");
  return runNativeEffect(
    Effect.gen(function* () {
      yield* nativePromise(() =>
        expect(
          collect([{ type: "error", code: "secret-code", message: "secret-response" }]),
        ).rejects.toBeInstanceOf(SubscriptionStreamFailed),
      );
      expect(
        Result.getOrThrow(
          Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))(log.mock.calls),
        ),
      ).not.toContain("secret");
      expect(log).toHaveBeenCalledWith("subscription model request failed", {
        provider: "openai",
        code: "SubscriptionStreamFailed",
      });
    }).pipe(Effect.ensuring(Effect.sync(() => log.mockRestore()))),
  );
});

test("owner abort during an unfinished public summary ends silently without false completion", () => {
  const controller = new AbortController();
  return runNativeEffect(
    Effect.gen(function* () {
      const adapter = new SubscriptionTextAdapter(
        {
          stream() {
            return nativeStream(
              Stream.fromIterable(
                (function* () {
                  yield start;
                  controller.abort();
                })(),
                { chunkSize: 1 },
              ),
            );
          },
        },
        { provider: "openai", model: "fixture", reasoningEffort: "medium" },
      );
      const chunks = yield* Stream.runCollect(
        Stream.fromAsyncIterable(
          adapter.chatStream({
            model: "fixture",
            messages: [],
            logger,
            abortController: controller,
          }),
          (cause) => new Cause.UnknownError(cause),
        ),
      );
      expect(chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false);
      expect(chunks.some((chunk) => chunk.type === EventType.REASONING_MESSAGE_START)).toBe(true);
    }),
  );
});

test("overlapping native blocks cannot overwrite another tool's pending result association", () =>
  runNativeEffect(
    nativePromise(() =>
      expect(
        collect([
          { type: "tool-call-start", index: 0, id: "first", name: "fixture" },
          { type: "tool-call-start", index: 0, id: "second", name: "fixture" },
        ]),
      ).rejects.toMatchObject({ reason: { _tag: "InvalidToolCall" } }),
    ),
  ));
