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

const context: OAuthHarnessErrorContext = {
  provider: "anthropic",
  operation: "subscription_usage",
};

/**
 * V1 evidence probe, not an adopted quota route: `SubscriptionQuota` still reports Anthropic as
 * unavailable. Sends exactly one usage request with the stored access token, refreshing first only
 * when that token has expired, and never retries.
 */
export const anthropicSubscriptionUsageProbe = Effect.fn("anthropicSubscriptionUsageProbe")(
  function* (options: {
    readonly store: CredentialStore;
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
      const client = createSubscriptionOAuthClient({
        protocol,
        store: options.store,
        fetch: fetcher,
        now,
      });
      yield* nativePromise(() => client.refreshForValidation());
      credential = yield* nativePromise(() => options.store.read("anthropic"));
      if (!isTruthy(credential))
        return yield* new OAuthHarnessError("not_connected", null, context);
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
    const fields = Object.entries(body);
    return {
      refreshed,
      status: response.status,
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
