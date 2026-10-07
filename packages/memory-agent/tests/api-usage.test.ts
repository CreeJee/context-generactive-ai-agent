import { it as effectTest } from "@effect/vitest";
import {
  deepStrictEqual,
  strictEqual,
  assertTrue,
  assertInstanceOf,
  throws,
} from "@effect/vitest/utils";
import { Context, Effect, Layer } from "effect";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { Database } from "../src/db/database.ts";

effectTest.effect(
  "OpenAI-compatible usage includes cache reads and preserves missing counters",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(layer);
      const usage = Context.get(services, ApiUsage);
      usage.record({
        rootSessionId: "compatible",
        purpose: "main",
        provider: "openai-compatible",
        model: "local",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
      });
      deepStrictEqual(usage.byRootSession("compatible"), {
        responses: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        uncachedInputTokens: 40,
        totalInputTokens: 100,
      });
      throws(
        () =>
          usage.record({
            rootSessionId: "compatible",
            purpose: "main",
            provider: "openai-compatible",
            model: "local",
            inputTokens: 1,
            cacheReadTokens: 2,
          }),
        (error) => {
          assertInstanceOf(error, RangeError);
          return undefined;
        },
      );
      usage.record({
        rootSessionId: "compatible",
        purpose: "main",
        provider: "openai-compatible",
        model: "local",
        inputTokens: 10,
        outputTokens: 2,
      });
      deepStrictEqual(usage.byRootSession("compatible"), {
        responses: 2,
        inputTokens: 110,
        outputTokens: 22,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        uncachedInputTokens: null,
        totalInputTokens: null,
      });
    }),
);

const database = Database.layer(":memory:");
const layer = Layer.provideMerge(ApiUsage.layer, database);

effectTest.effect("records individual provider responses and sums cache exactly once", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layer);
    const usage = Context.get(services, ApiUsage);
    const first = usage.record({
      rootSessionId: "root",
      runId: "run",
      threadId: "thread",
      purpose: "main",
      provider: "openai",
      model: "gpt",
      inputTokens: 100,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
      outputTokens: 20,
    });
    const second = usage.record({
      rootSessionId: "root",
      purpose: "summary",
      provider: "anthropic",
      model: "claude",
      inputTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      outputTokens: 8,
    });
    assertTrue(first !== second);
    deepStrictEqual(usage.byRootSession("root"), {
      responses: 2,
      inputTokens: 110,
      outputTokens: 28,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
      uncachedInputTokens: 50,
      totalInputTokens: 145,
    });
    strictEqual(usage.byRootSession("other").responses, 0);
  }),
);

effectTest.effect(
  "unknown counters remain unknown rather than becoming zero; only counts are stored",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(layer);
      const usage = Context.get(services, ApiUsage);
      const { sqlite } = Context.get(services, Database);
      usage.record({
        rootSessionId: "root",
        purpose: "tool",
        provider: "openai",
        model: "gpt",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      usage.record({
        rootSessionId: "root",
        purpose: "subagent",
        provider: "anthropic",
        model: "claude",
      });
      deepStrictEqual(usage.byRootSession("root"), {
        responses: 2,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        uncachedInputTokens: null,
        totalInputTokens: null,
      });
      const columns = sqlite.prepare("SELECT * FROM api_usage_responses ORDER BY id").all();
      strictEqual(columns.length, 2);
      deepStrictEqual(
        Object.keys(columns[0]).sort(),
        [
          "id",
          "root_session_id",
          "run_id",
          "thread_id",
          "purpose",
          "provider",
          "model",
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
          "cache_mode",
          "created_at",
        ].sort(),
      );
      strictEqual(columns[1]?.input_tokens, null);
      throws(
        () =>
          usage.record({
            rootSessionId: "root",
            purpose: "main",
            provider: "openai",
            model: "gpt",
            inputTokens: 1,
            cacheReadTokens: 2,
          }),
        (error) => {
          assertInstanceOf(error, RangeError);
          return undefined;
        },
      );
      strictEqual(usage.byRootSession("root").responses, 2);
    }),
);
