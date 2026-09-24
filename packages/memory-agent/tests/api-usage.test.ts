import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { Database } from "../src/db/database.ts";

const database = Database.layer(":memory:");
const layer = Layer.provideMerge(ApiUsage.layer, database);

test("records individual provider responses and sums cache exactly once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const usage = yield* ApiUsage;
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
      assert.notEqual(first, second);
      assert.deepEqual(usage.byRootSession("root"), {
        responses: 2,
        inputTokens: 110,
        outputTokens: 28,
        cacheReadTokens: 90,
        cacheWriteTokens: 5,
        uncachedInputTokens: 50,
        totalInputTokens: 145,
      });
      assert.equal(usage.byRootSession("other").responses, 0);
    }).pipe(Effect.provide(layer)),
  );
});

test("unknown counters remain unknown rather than becoming zero; only counts are stored", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const usage = yield* ApiUsage;
      const { sqlite } = yield* Database;
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
      assert.deepEqual(usage.byRootSession("root"), {
        responses: 2,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        uncachedInputTokens: null,
        totalInputTokens: null,
      });
      const columns = sqlite.prepare("SELECT * FROM api_usage_responses ORDER BY id").all();
      assert.equal(columns.length, 2);
      assert.deepEqual(
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
      assert.equal(columns[1]?.input_tokens, null);
      assert.throws(
        () =>
          usage.record({
            rootSessionId: "root",
            purpose: "main",
            provider: "openai",
            model: "gpt",
            inputTokens: 1,
            cacheReadTokens: 2,
          }),
        RangeError,
      );
      assert.equal(usage.byRootSession("root").responses, 2);
    }).pipe(Effect.provide(layer)),
  );
});
