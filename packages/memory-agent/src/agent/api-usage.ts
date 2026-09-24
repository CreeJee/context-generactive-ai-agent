import type { ChatMiddleware } from "@tanstack/ai";
import { optionalProperty } from "../optional-property.ts";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";

export type ApiUsageProvider = "openai" | "anthropic";
export interface ApiUsageResponse {
  readonly rootSessionId: string;
  readonly runId?: string | null;
  readonly threadId?: string | null;
  readonly purpose: string;
  readonly provider: ApiUsageProvider;
  readonly model: string;
  /** OpenAI: total input including cache reads. Anthropic: uncached input only. */
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
}

export interface ApiUsageTotals {
  readonly responses: number;
  /** Null means at least one response did not report this count. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** Derived without double-counting cache reads or writes. */
  readonly uncachedInputTokens: number | null;
  readonly totalInputTokens: number | null;
}

const CountRow = Schema.Struct({
  responses: Schema.Finite,
  input_tokens: Schema.NullOr(Schema.Finite),
  output_tokens: Schema.NullOr(Schema.Finite),
  cache_read_tokens: Schema.NullOr(Schema.Finite),
  cache_write_tokens: Schema.NullOr(Schema.Finite),
  uncached_input_tokens: Schema.NullOr(Schema.Finite),
  total_input_tokens: Schema.NullOr(Schema.Finite),
});
const decodeCount = Schema.decodeUnknownSync(CountRow);

function count(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Token counts must be nonnegative safe integers");
  return value;
}

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const insert = sqlite.prepare(`INSERT INTO api_usage_responses
    (root_session_id, run_id, thread_id, purpose, provider, model, input_tokens,
     output_tokens, cache_read_tokens, cache_write_tokens, cache_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A NULL count is unknown, not zero. SUM by itself silently drops unknown rows.
  const totals = sqlite.prepare(`SELECT count(*) AS responses,
    CASE WHEN count(input_tokens) = count(*) THEN sum(input_tokens) ELSE NULL END AS input_tokens,
    CASE WHEN count(output_tokens) = count(*) THEN sum(output_tokens) ELSE NULL END AS output_tokens,
    CASE WHEN count(cache_read_tokens) = count(*) THEN sum(cache_read_tokens) ELSE NULL END AS cache_read_tokens,
    CASE WHEN count(cache_write_tokens) = count(*) THEN sum(cache_write_tokens) ELSE NULL END AS cache_write_tokens,
    CASE WHEN count(input_tokens) = count(*) AND count(cache_read_tokens) = count(*)
      THEN sum(CASE WHEN cache_mode = 'included' THEN input_tokens - cache_read_tokens ELSE input_tokens END)
      ELSE NULL END AS uncached_input_tokens,
    CASE WHEN count(input_tokens) = count(*) AND count(cache_read_tokens) = count(*)
      AND count(cache_write_tokens) = count(*)
      THEN sum(CASE WHEN cache_mode = 'included' THEN input_tokens + cache_write_tokens
        ELSE input_tokens + cache_read_tokens + cache_write_tokens END)
      ELSE NULL END AS total_input_tokens
    FROM api_usage_responses WHERE root_session_id = ?`);
  return {
    /** Call once for each *actual provider response*, including auxiliary responses. Returns its unique row id. */
    record(response: ApiUsageResponse): number {
      if (!response.rootSessionId || !response.purpose || !response.model)
        throw new Error("Usage attribution is required");
      const input = count(response.inputTokens);
      const read = count(response.cacheReadTokens);
      const write = count(response.cacheWriteTokens);
      const output = count(response.outputTokens);
      if (response.provider !== "openai" && response.provider !== "anthropic")
        throw new Error("Unknown cache mode");
      if (response.provider === "openai" && input !== null && read !== null && read > input)
        throw new RangeError("Cache reads exceed included input tokens");
      const result = insert.run(
        response.rootSessionId,
        response.runId ?? null,
        response.threadId ?? null,
        response.purpose,
        response.provider,
        response.model,
        input,
        output,
        read,
        write,
        response.provider === "openai" ? "included" : "separate",
        Date.now(),
      );
      return Number(result.lastInsertRowid);
    },
    byRootSession(rootSessionId: string): ApiUsageTotals {
      const row = decodeCount(totals.get(rootSessionId));
      return {
        responses: row.responses,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        uncachedInputTokens: row.uncached_input_tokens,
        totalInputTokens: row.total_input_tokens,
      };
    },
  };
});

/** Counts-only provider response capture; never persist prompts, messages or tool arguments. */
export const collectApiUsage = (
  ledger: { record: (response: ApiUsageResponse) => number },
  source: Pick<ApiUsageResponse, "rootSessionId" | "purpose" | "provider" | "model">,
): ChatMiddleware => ({
  name: "memory-agent/api-usage",
  onUsage(ctx, usage) {
    ledger.record({
      ...source,
      runId: ctx.runId,
      threadId: ctx.threadId,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      ...optionalProperty("cacheReadTokens", usage.promptTokensDetails?.cachedTokens),
      ...optionalProperty("cacheWriteTokens", usage.promptTokensDetails?.cacheWriteTokens),
    });
  },
});

export class ApiUsage extends Context.Service<ApiUsage, Effect.Success<typeof make>>()(
  "memory-agent/ApiUsage",
) {
  static readonly layer = Layer.effect(ApiUsage, make);
}
