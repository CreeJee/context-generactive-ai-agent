import { DateTime, Duration, Effect, Option, Schema } from "effect";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import { OAuthHarnessError, type SubscriptionOAuthClient } from "./validation-harness.ts";

/** The internal usage endpoints third-party clients call (docs/subscription-quota-research.md). */
export const anthropicUsageUrl = providerProtocols.anthropic.usageUrl;
/** The ChatGPT backend usage endpoint Codex's backend client reads for its rate-limit status. */
export const openAiUsageUrl = providerProtocols.openai.usageUrl;

/** The one client method a usage lookup needs: the account's own usage request. */
export type SubscriptionUsageClient = Pick<SubscriptionOAuthClient, "subscriptionUsage">;

const UsageObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeUsageWindow = Schema.decodeUnknownOption(
  Schema.StructWithRest(Schema.Struct({ utilization: Schema.NullOr(Schema.Finite) }), [
    UsageObject,
  ]),
);

/** Secret-free shape of one usage response: names only, never values, tokens or account details. */
export interface SubscriptionUsageProbe {
  readonly status: number;
  readonly fieldNames: readonly string[];
  readonly windows: readonly { readonly name: string; readonly fieldNames: readonly string[] }[];
}

/** One provider-reported window; `usedPercent` is the provider's own percentage of that window. */
export interface SubscriptionUsageWindow {
  readonly name: string;
  readonly usedPercent: number;
  readonly windowSeconds: number | null;
  readonly resetsAt: string | null;
}

/** The provider refused the lookup as too frequent (429); `retryAfter` is its `Retry-After` wait. */
export class SubscriptionUsageRateLimited extends Schema.TaggedError<
  SubscriptionUsageRateLimited,
  { readonly brand: unique symbol }
>()("SubscriptionUsageRateLimited", {
  retryAfter: Schema.Option(Schema.Duration),
}) {}

/** `Retry-After` as delay seconds or an HTTP date (RFC 9110); an unreadable value is absent. */
const retryAfterOf = (header: string | null, now: number) =>
  Option.fromNullishOr(header).pipe(
    Option.map((value) => value.trim()),
    Option.flatMap((value) =>
      /^\d+$/.test(value)
        ? Option.some(Duration.seconds(Number(value)))
        : Option.map(DateTime.make(value), (date) =>
            Duration.millis(Math.max(0, DateTime.toEpochMillis(date) - now)),
          ),
    ),
  );

/**
 * Sends one usage request through the account's client, which refreshes an expiring token first
 * under the same lock its model requests use, so the two never spend one rotating refresh token
 * twice. A 429 fails with the provider's `Retry-After` so the caller can wait it out.
 */
const requestUsage = Effect.fn("requestSubscriptionUsage")(function* (options: {
  readonly provider: OAuthProvider;
  readonly client: SubscriptionUsageClient;
  readonly now?: () => number;
}) {
  const context = { provider: options.provider, operation: "subscription_usage" } as const;
  const now = options.now ?? Date.now;
  const response = yield* options.client.subscriptionUsage.pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) =>
        response.status === 429
          ? SubscriptionUsageRateLimited.make({
              retryAfter: retryAfterOf(response.headers.get("retry-after"), now()),
            })
          : OAuthHarnessError.fromCode("provider_rejected", response.status, context),
    ),
  );
  const body = yield* Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UsageObject)),
    Effect.mapError(() =>
      OAuthHarnessError.fromCode("provider_rejected", response.status, context),
    ),
  );
  return { status: response.status, body };
});

/** V1 evidence probe: one request, reporting only field names. */
export const anthropicSubscriptionUsageProbe = Effect.fn("anthropicSubscriptionUsageProbe")(
  function* (options: { readonly client: SubscriptionUsageClient }) {
    const { status, body } = yield* requestUsage({ ...options, provider: "anthropic" });
    const fields = Object.entries(body);
    return {
      status,
      fieldNames: fields.map(([name]) => name),
      windows: fields.flatMap(([name, value]) =>
        Option.match(decodeUsageWindow(value), {
          onNone: () => [],
          onSome: (window) => [{ name, fieldNames: Object.keys(window) }],
        }),
      ),
    } satisfies SubscriptionUsageProbe;
  },
);

/** The windows the sidebar shows, with their fixed lengths; other usage fields are undocumented. */
const anthropicQuotaWindows = { five_hour: 5 * 60 * 60, seven_day: 7 * 24 * 60 * 60 } as const;
const decodeQuotaWindow = Schema.decodeUnknownOption(
  Schema.Struct({
    utilization: Schema.Finite,
    resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

/**
 * The adopted quota route (decision 2026-10-12): the provider's own utilization for the named
 * windows. Since 2026-11-18 an expiring token is refreshed first, so an account that is not
 * selected keeps its windows. A window without a number is omitted rather than shown as zero.
 */
export const anthropicSubscriptionUsage = Effect.fn("anthropicSubscriptionUsage")(
  function* (options: { readonly client: SubscriptionUsageClient; readonly now?: () => number }) {
    const { body } = yield* requestUsage({ ...options, provider: "anthropic" });
    return Object.entries(anthropicQuotaWindows).flatMap(([name, windowSeconds]) =>
      Option.match(decodeQuotaWindow(body[name]), {
        onNone: () => [],
        onSome: (window): readonly SubscriptionUsageWindow[] => [
          {
            name,
            usedPercent: window.utilization,
            windowSeconds,
            resetsAt: window.resets_at ?? null,
          },
        ],
      }),
    );
  },
);

/**
 * Codex's rate-limit payload: a `primary` and an optional `secondary` window, each with the
 * provider's used percent, window length and Unix reset time. Other fields are not read.
 */
const OpenAiRateLimitWindow = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const decodeOpenAiRateLimit = Schema.decodeUnknownOption(
  Schema.Struct({
    rate_limit: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          primary_window: Schema.optional(Schema.NullOr(OpenAiRateLimitWindow)),
          secondary_window: Schema.optional(Schema.NullOr(OpenAiRateLimitWindow)),
        }),
      ),
    ),
  }),
);

/**
 * The adopted OpenAI quota route (decision 2026-10-12): Codex's `/wham/usage` windows for the
 * stored ChatGPT account, refreshing an expiring token first. A missing window is omitted.
 */
export const openAiSubscriptionUsage = Effect.fn("openAiSubscriptionUsage")(function* (options: {
  readonly client: SubscriptionUsageClient;
  readonly now?: () => number;
}) {
  const { body } = yield* requestUsage({ ...options, provider: "openai" });
  const limits = Option.getOrUndefined(decodeOpenAiRateLimit(body))?.rate_limit;
  return [
    { name: "primary", window: limits?.primary_window },
    { name: "secondary", window: limits?.secondary_window },
  ].flatMap(({ name, window }): readonly SubscriptionUsageWindow[] =>
    window === undefined || window === null
      ? []
      : [
          {
            name,
            usedPercent: window.used_percent,
            windowSeconds: window.limit_window_seconds ?? null,
            resetsAt:
              window.reset_at === undefined || window.reset_at === null
                ? null
                : DateTime.formatIso(DateTime.makeUnsafe(window.reset_at * 1000)),
          },
        ],
  );
});
