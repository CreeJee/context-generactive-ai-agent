import { optionalProperty } from "../optional-property.ts";
import { Clock, Context, Effect, Function as EffectFunction, Layer, Option, Schema } from "effect";
import type { Response } from "effect/ai";
import { SqlClient, SqlSchema } from "effect/sql";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import type { ProviderId } from "../providers/contracts.ts";

export type ApiUsageProvider = ProviderId;
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
/** A usage record the ledger refuses: it would make the totals wrong or unattributed. */
export class ApiUsageRejected extends Schema.TaggedError<
  ApiUsageRejected,
  { readonly brand: unique symbol }
>()("ApiUsageRejected", {
  reason: Schema.Literals([
    "attribution-missing",
    "invalid-count",
    "unknown-cache-mode",
    "cache-exceeds-input",
  ]),
}) {}

const count = (value: number | null | undefined) =>
  value == null
    ? Effect.succeed(null)
    : Number.isSafeInteger(value) && value >= 0
      ? Effect.succeed(value)
      : Effect.fail(ApiUsageRejected.make({ reason: "invalid-count" }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A NULL count is unknown, not zero. SUM by itself silently drops unknown rows.
  const totals = SqlSchema.findOne({
    Request: Schema.String,
    Result: CountRow,
    execute: (rootSessionId) => sql`SELECT count(*) AS responses,
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
      FROM api_usage_responses WHERE root_session_id = ${rootSessionId}`,
  });
  const insert = SqlSchema.findOne({
    Request: Schema.Struct({
      rootSessionId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      threadId: Schema.NullOr(Schema.String),
      purpose: Schema.String,
      provider: Schema.String,
      model: Schema.String,
      input: Schema.NullOr(Schema.Finite),
      output: Schema.NullOr(Schema.Finite),
      read: Schema.NullOr(Schema.Finite),
      write: Schema.NullOr(Schema.Finite),
      cacheMode: Schema.Literals(["included", "separate"]),
      createdAt: Schema.Finite,
    }),
    Result: Schema.Struct({ id: Schema.Finite }),
    execute: (row) => sql`INSERT INTO api_usage_responses
      (root_session_id, run_id, thread_id, purpose, provider, model, input_tokens,
       output_tokens, cache_read_tokens, cache_write_tokens, cache_mode, created_at)
      VALUES (${row.rootSessionId}, ${row.runId}, ${row.threadId}, ${row.purpose}, ${row.provider},
        ${row.model}, ${row.input}, ${row.output}, ${row.read}, ${row.write}, ${row.cacheMode},
        ${row.createdAt})
      RETURNING id`,
  });
  return {
    /** Call once for each *actual provider response*, including auxiliary responses. Returns its unique row id. */
    record: Effect.fn("ApiUsage.record")(function* (response: ApiUsageResponse) {
      if (
        !(response.rootSessionId.length > 0) ||
        !(response.purpose.length > 0) ||
        !(response.model.length > 0)
      )
        return yield* ApiUsageRejected.make({ reason: "attribution-missing" });
      const input = yield* count(response.inputTokens);
      const read = yield* count(response.cacheReadTokens);
      const write = yield* count(response.cacheWriteTokens);
      const output = yield* count(response.outputTokens);
      const included = response.provider === "openai" || response.provider === "openai-compatible";
      if (!included && response.provider !== "anthropic")
        return yield* ApiUsageRejected.make({ reason: "unknown-cache-mode" });
      if (included && input !== null && read !== null && read > input)
        return yield* ApiUsageRejected.make({ reason: "cache-exceeds-input" });
      const { id } = yield* insert({
        rootSessionId: response.rootSessionId,
        runId: response.runId ?? null,
        threadId: response.threadId ?? null,
        purpose: response.purpose,
        provider: response.provider,
        model: response.model,
        input,
        output,
        read,
        write,
        cacheMode: included ? "included" : "separate",
        createdAt: yield* Clock.currentTimeMillis,
      });
      return id;
    }),
    byRootSession: (rootSessionId: string) =>
      Effect.map(totals(rootSessionId), (row): ApiUsageTotals => ({
        responses: row.responses,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        uncachedInputTokens: row.uncached_input_tokens,
        totalInputTokens: row.total_input_tokens,
      })),
  };
});

type UsageLedger = Pick<Effect.Success<typeof make>, "record">;

/** An Effect AI response: who it counts for, and the provider's counts. */
type UsageResponse = Omit<
  ApiUsageResponse,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
> & { readonly usage: Response.Usage };

/** An Effect AI response's counts as the ledger keeps them. */
const usageRecord = ({
  usage: { inputTokens, outputTokens },
  ...response
}: UsageResponse): ApiUsageResponse => ({
  ...response,
  // `total` is the whole input; an Anthropic row keeps only its uncached part.
  inputTokens: Option.getOrNull(
    Option.map(Option.fromNullishOr(inputTokens.total), (total) =>
      response.provider === "anthropic"
        ? total - (inputTokens.cacheRead ?? 0) - (inputTokens.cacheWrite ?? 0)
        : total,
    ),
  ),
  outputTokens: outputTokens.total ?? null,
  ...optionalProperty("cacheReadTokens", inputTokens.cacheRead),
  ...optionalProperty("cacheWriteTokens", inputTokens.cacheWrite),
});

/** Records an Effect AI response; one whose provider reported no counts leaves no row. */
const recordUsageBody = (ledger: UsageLedger, response: UsageResponse) =>
  Effect.when(
    ledger.record(usageRecord(response)),
    Effect.succeed(
      response.usage.inputTokens.total !== undefined ||
        response.usage.outputTokens.total !== undefined,
    ),
  );
export const recordUsage: {
  (response: UsageResponse): (ledger: UsageLedger) => ReturnType<typeof recordUsageBody>;
} & typeof recordUsageBody = EffectFunction.dual(2, recordUsageBody);

/** Counts-only provider response capture; never persist prompts, messages or tool arguments. */
const apiUsageHookBody = (
  ledger: UsageLedger,
  source: Pick<ApiUsageResponse, "rootSessionId" | "purpose" | "provider" | "model">,
): RunHook => ({
  usage: ({ runId, threadId }, usage) =>
    recordUsage(ledger, { ...source, runId, threadId, usage }).pipe(
      Effect.asVoid,
      Effect.mapError(asRunFailed),
    ),
});
export const apiUsageHook: {
  (
    source: Pick<ApiUsageResponse, "rootSessionId" | "purpose" | "provider" | "model">,
  ): (ledger: UsageLedger) => ReturnType<typeof apiUsageHookBody>;
} & typeof apiUsageHookBody = EffectFunction.dual(2, apiUsageHookBody);

export class ApiUsage extends Context.Service<ApiUsage, Effect.Success<typeof make>>()(
  "memory-agent/agent/api-usage/ApiUsage",
) {
  static readonly layer = Layer.effect(ApiUsage, make);
}
