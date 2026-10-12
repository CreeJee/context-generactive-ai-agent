import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";
import { listOAuthProfiles } from "./accounts.ts";

/**
 * A provider-reported window. `usedPercent` is the provider's own percentage of this named window,
 * never a count of local responses or tokens.
 */
export const SubscriptionQuotaWindow = Schema.Struct({
  name: Schema.String,
  usedPercent: Schema.Finite,
  windowSeconds: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(Schema.String),
});
export type SubscriptionQuotaWindow = typeof SubscriptionQuotaWindow.Type;

/**
 * Why no quota can be shown. `no_permitted_route`: no supported, allowed route for this app's
 * credential is verified. `provider_policy_restricted`: the provider's terms restrict third-party
 * use of its consumer login, so an internal usage call is not made.
 */
export const SubscriptionQuotaUnavailableReason = Schema.Literals([
  "no_permitted_route",
  "provider_policy_restricted",
]);
export type SubscriptionQuotaUnavailableReason = typeof SubscriptionQuotaUnavailableReason.Type;

/** `stale` keeps the last observation and when the newer lookup failed; it is never reset to zero. */
export const SubscriptionQuotaStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("observed"),
    windows: Schema.Array(SubscriptionQuotaWindow),
    observedAt: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("stale"),
    windows: Schema.Array(SubscriptionQuotaWindow),
    observedAt: Schema.String,
    failedAt: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: SubscriptionQuotaUnavailableReason,
  }),
]);
export type SubscriptionQuotaStatus = typeof SubscriptionQuotaStatus.Type;

export const SubscriptionAccountQuota = Schema.Struct({
  accountId: Schema.String,
  label: Schema.String,
  selected: Schema.Boolean,
  quota: SubscriptionQuotaStatus,
});
export type SubscriptionAccountQuota = typeof SubscriptionAccountQuota.Type;

export const SubscriptionQuotaReport = Schema.Struct({
  provider: SubscriptionAccountProvider,
  checkedAt: Schema.String,
  accounts: Schema.Array(SubscriptionAccountQuota),
});
export type SubscriptionQuotaReport = typeof SubscriptionQuotaReport.Type;

export class SubscriptionQuotaError extends Schema.TaggedError<SubscriptionQuotaError>()(
  "SubscriptionQuotaError",
  { reason: Schema.Literal("profiles_unreadable"), cause: Schema.Defect() },
) {}

/**
 * The quota route each provider may use. No route is verified and allowed yet (see
 * docs/subscription-quota-research.md), so every account reports why it is unavailable instead of
 * calling an internal usage endpoint or estimating from local token counts.
 */
export const subscriptionQuotaRoutes = {
  openai: { status: "unavailable", reason: "no_permitted_route" },
  anthropic: { status: "unavailable", reason: "provider_policy_restricted" },
} as const satisfies Record<SubscriptionAccountProvider, SubscriptionQuotaStatus>;

export class SubscriptionQuota extends Context.Service<
  SubscriptionQuota,
  {
    readonly accounts: (
      provider: SubscriptionAccountProvider,
    ) => Effect.Effect<SubscriptionQuotaReport, SubscriptionQuotaError>;
  }
>()("memory-agent/oauth/SubscriptionQuota") {
  static readonly layer = Layer.effect(
    SubscriptionQuota,
    Effect.gen(function* () {
      const { sqlite } = yield* Database;
      const accounts = Effect.fn("SubscriptionQuota.accounts")(function* (
        provider: SubscriptionAccountProvider,
      ) {
        const profiles = yield* Effect.try({
          try: () => listOAuthProfiles({ sqlite, provider }),
          catch: (cause) => new SubscriptionQuotaError({ reason: "profiles_unreadable", cause }),
        });
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return {
          provider,
          checkedAt,
          accounts: profiles.map((profile) => ({
            accountId: profile.id,
            label: profile.label,
            selected: profile.selected,
            quota: subscriptionQuotaRoutes[provider],
          })),
        };
      });
      return SubscriptionQuota.of({ accounts });
    }),
  );
}
