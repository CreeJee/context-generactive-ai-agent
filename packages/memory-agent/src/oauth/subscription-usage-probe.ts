import { Effect, Option, Schema } from "effect";
import { isTruthy } from "../truthy.ts";
import { nativePromise } from "../runtime/native-effect.ts";
import { providerProtocols } from "./protocol.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type OAuthHarnessErrorContext,
} from "./validation-harness.ts";

/** The internal usage endpoint third-party clients call (docs/subscription-quota-research.md). */
export const anthropicUsageUrl = "https://api.anthropic.com/api/oauth/usage";

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

/** One provider-reported window; `usedPercent` is the provider's own `utilization` percentage. */
export interface AnthropicUsageWindow {
  readonly name: string;
  readonly usedPercent: number;
  readonly windowSeconds: number;
  readonly resetsAt: string | null;
}

/** The stored access token has expired and this lookup may not refresh it. */
export class SubscriptionUsageCredentialExpired extends Schema.TaggedError<SubscriptionUsageCredentialExpired>()(
  "SubscriptionUsageCredentialExpired",
  {},
) {}

const context: OAuthHarnessErrorContext = {
  provider: "anthropic",
  operation: "subscription_usage",
};

/**
 * Sends exactly one usage request with the stored access token and never retries. An expired token
 * is refreshed first only when `refreshExpired` allows it; otherwise the lookup fails without a
 * request so it never races the model path's own refresh of a rotating refresh token.
 */
const requestAnthropicUsage = Effect.fn("requestAnthropicUsage")(function* (options: {
  readonly store: CredentialStore;
  readonly refreshExpired: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const protocol = providerProtocols.anthropic;
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  let credential = yield* nativePromise(() => options.store.read("anthropic"));
  if (!isTruthy(credential)) return yield* new OAuthHarnessError("not_connected", null, context);
  // The app's own expiry margin: the same credential would be refreshed before a model request.
  const refreshed = credential.expiresAt <= now() + 30_000;
  if (refreshed) {
    if (!options.refreshExpired) return yield* SubscriptionUsageCredentialExpired.make({});
    const client = createSubscriptionOAuthClient({
      protocol,
      store: options.store,
      fetch: fetcher,
      now,
    });
    yield* nativePromise(() => client.refreshForValidation());
    credential = yield* nativePromise(() => options.store.read("anthropic"));
    if (!isTruthy(credential)) return yield* new OAuthHarnessError("not_connected", null, context);
  }
  const headers = new Headers(protocol.modelHeaders);
  headers.set("Accept", "application/json");
  headers.delete("Content-Type");
  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetcher(anthropicUsageUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      }),
    catch: () => new OAuthHarnessError("transport_unavailable", null, context),
  });
  if (!response.ok)
    return yield* new OAuthHarnessError("provider_rejected", response.status, context);
  const body = yield* nativePromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UsageObject)),
    Effect.mapError(() => new OAuthHarnessError("provider_rejected", response.status, context)),
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
    const { refreshed, status, body } = yield* requestAnthropicUsage({
      ...options,
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
    const { body } = yield* requestAnthropicUsage({ ...options, refreshExpired: false });
    return Object.entries(anthropicQuotaWindows).flatMap(([name, windowSeconds]) =>
      Option.match(decodeQuotaWindow(body[name]), {
        onNone: () => [],
        onSome: (window): readonly AnthropicUsageWindow[] => [
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
