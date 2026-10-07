import { it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { EventType } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { expect } from "vite-plus/test";
import { ExternalAgentAdapter } from "../src/external-agents/adapter.ts";
import type { ExternalPromptOutcome } from "../src/external-agents/agents.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";

it.effect("cancellation releases an empty queue even when the native agent has not settled", () =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<ExternalPromptOutcome>();
    const entered = yield* Deferred.make<void>();
    const run = Effect.runPromiseWith(yield* Effect.context());
    const adapter = new ExternalAgentAdapter(
      "fixture",
      () =>
        run(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(completion)))),
      () => Promise.resolve(""),
    );
    const { controller: abortController } = yield* sdkCancellation;
    const iterator = adapter
      .chatStream({
        model: "fixture",
        messages: [],
        abortController,
        logger: resolveDebugOption(false),
      })
      [Symbol.asyncIterator]();
    expect((yield* Effect.promise(() => iterator.next())).value?.type).toBe(EventType.RUN_STARTED);
    const pending = iterator.next();
    yield* Deferred.await(entered);
    abortController.abort();
    expect(yield* Effect.promise(() => pending)).toEqual({ done: true, value: undefined });
    // A late completion cannot enqueue another event into the closed iterator.
    yield* Deferred.succeed(completion, {
      status: "cancelled",
      stopReason: "cancelled",
      answer: "",
      toolCalls: [],
    });
    expect(yield* Effect.promise(() => iterator.next())).toEqual({ done: true, value: undefined });
  }),
);
