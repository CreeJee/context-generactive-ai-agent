// TanStack's async iterator is the boundary under test.
// @effect-diagnostics asyncFunction:off
import { Deferred, Effect } from "effect";
import { EventType } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { expect, test } from "vite-plus/test";
import { ExternalAgentAdapter } from "../src/external-agents/adapter.ts";
import type { ExternalPromptOutcome } from "../src/external-agents/agents.ts";

test("cancellation releases an empty queue even when the native agent has not settled", async () => {
  const completion = Deferred.makeUnsafe<ExternalPromptOutcome>();
  const entered = Deferred.makeUnsafe<void>();
  const adapter = new ExternalAgentAdapter(
    "fixture",
    () => {
      Deferred.doneUnsafe(entered, Effect.void);
      return Effect.runPromise(Deferred.await(completion));
    },
    () => Promise.resolve(""),
  );
  const abortController = new AbortController();
  const iterator = adapter
    .chatStream({
      model: "fixture",
      messages: [],
      abortController,
      logger: resolveDebugOption(false),
    })
    [Symbol.asyncIterator]();
  expect((await iterator.next()).value?.type).toBe(EventType.RUN_STARTED);
  const pending = iterator.next();
  await Effect.runPromise(Deferred.await(entered));
  abortController.abort();
  expect(await pending).toEqual({ done: true, value: undefined });
  // A late completion cannot enqueue another event into the closed iterator.
  Deferred.doneUnsafe(
    completion,
    Effect.succeed({
      status: "cancelled",
      stopReason: "cancelled",
      answer: "",
      toolCalls: [],
    }),
  );
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});
