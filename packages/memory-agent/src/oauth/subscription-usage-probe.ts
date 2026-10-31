import { DateTime, Duration, Effect, Option, Schema } from "effect";
import { isTruthy } from "../truthy.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type OAuthHarnessErrorContext,
} from "./validation-harness.ts";

/** The internal usage endpoints third-party clients call (docs/subscription-quota-research.md). */
export const anthropicUsageUrl = "https://api.anthropic.com/api/oauth/usage";
/** The ChatGPT backend usage endpoint Codex's backend client reads for its rate-limit status. */
export const openAiUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const usageUrls = { anthropic: anthropicUsageUrl, openai: openAiUsageUrl } as const;

const UsageObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeUsageWindow = Schema.decodeUnknownOption(
  Schema.StructWithRest(Schema.Struct({ utilization: Schema.NullOr(Schema.Finite) }), [
    UsageObject,
  ]),
);

/** Secret-free shape of one usage response: names only, never values, tokens or account details. */
export interface SubscriptionUsageProbe {
  readonly refreshed: boolean;
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

/** The stored access token has expired and this lookup may not refresh it. */
export class SubscriptionUsageCredentialExpired extends Schema.TaggedError<
  SubscriptionUsageCredentialExpired,
  { readonly brand: unique symbol }
>()("SubscriptionUsageCredentialExpired", {}) {}

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
 * Sends exactly one usage request with the stored access token and never retries. An expired token
 * is refreshed first only when `refreshExpired` allows it; otherwise the lookup fails without a
 * request so it never races the model path's own refresh of a rotating refresh token. A 429 fails
 * with the provider's `Retry-After` so the caller can wait it out.
 */
const requestUsage = Effect.fn("requestSubscriptionUsage")(function* (options: {
  readonly provider: OAuthProvider;
  readonly store: CredentialStore;
  readonly refreshExpired: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const { provider } = options;
  const context: OAuthHarnessErrorContext = { provider, operation: "subscription_usage" };
  const protocol = providerProtocols[provider];
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  const readCredential = options.store
    .read(provider)
    .pipe(
      Effect.filterOrFail(isTruthy, () =>
        OAuthHarnessError.fromCode("not_connected", null, context),
      ),
    );
  const stored = yield* readCredential;
  // The app's own expiry margin: the same credential would be refreshed before a model request.
  const refreshed = stored.expiresAt <= now() + 30_000;
  yield* Effect.when(
    Effect.fail(SubscriptionUsageCredentialExpired.make({})),
    Effect.succeed(refreshed && !options.refreshExpired),
  );
  const credential = refreshed
    ? yield* createSubscriptionOAuthClient({
        protocol,
        store: options.store,
        fetch: fetcher,
        now,
      }).pipe(
        Effect.flatMap((client) => client.refreshForValidation),
        Effect.andThen(readCredential),
      )
    : stored;
  const headers = new Headers(protocol.modelHeaders);
  headers.set("Accept", "application/json");
  headers.delete("Content-Type");
  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  if (provider === "openai" && credential.accountId !== undefined)
    headers.set("chatgpt-account-id", credential.accountId);
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetcher(usageUrls[provider], {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      }),
    catch: () => OAuthHarnessError.fromCode("transport_unavailable", null, context),
  }).pipe(
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
  return { refreshed, status: response.status, body };
});

/**
 * V1 evidence probe: one request, refreshing an expired token first, reporting only field names.
 */
export const anthropicSubscriptionUsageProbe = Effect.fn("anthropicSubscriptionUsageProbe")(
  function* (options: {
    readonly store: CredentialStore;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {
    const { refreshed, status, body } = yield* requestUsage({
      ...options,
      provider: "anthropic",
      refreshExpired: true,
    });
    const fields = Object.entries(body);
    return {
      refreshed,
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
 * windows, read with the stored token and never refreshing it. A window without a number is
 * omitted rather than shown as zero.
 */
export const anthropicSubscriptionUsage = Effect.fn("anthropicSubscriptionUsage")(
  function* (options: {
    readonly store: CredentialStore;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {
    const { body } = yield* requestUsage({
      ...options,
      provider: "anthropic",
      refreshExpired: false,
    });
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
 * stored ChatGPT account, read without refreshing its token. A missing window is omitted.
 */
export const openAiSubscriptionUsage = Effect.fn("openAiSubscriptionUsage")(function* (options: {
  readonly store: CredentialStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const { body } = yield* requestUsage({ ...options, provider: "openai", refreshExpired: false });
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
