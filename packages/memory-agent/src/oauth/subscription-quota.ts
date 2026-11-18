import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import type { SubscriptionAccountProvider } from "../providers/contracts.ts";
import { SubscriptionAccountClients } from "./account-bound.ts";
import { OAuthProfiles } from "./accounts.ts";
import {
  SubscriptionQuotaStatus,
  type SubscriptionQuotaReport,
  type SubscriptionQuotaUnavailableReason,
  type SubscriptionQuotaWindow,
} from "./contracts.ts";
import {
  anthropicSubscriptionUsage,
  openAiSubscriptionUsage,
  type SubscriptionUsageRateLimited,
} from "./subscription-usage-probe.ts";
import { invalidatesStoredCredential, type OAuthHarnessError } from "./validation-harness.ts";

export {
  SubscriptionAccountQuota,
  SubscriptionQuotaReport,
  SubscriptionQuotaStatus,
  SubscriptionQuotaUnavailableReason,
  SubscriptionQuotaWindow,
} from "./contracts.ts";

export class SubscriptionQuotaError extends Schema.TaggedError<
  SubscriptionQuotaError,
  { readonly brand: unique symbol }
>()("SubscriptionQuotaError", {
  reason: Schema.Literal("profiles_unreadable"),
  cause: Schema.Defect(),
}) {}

const subscriptionUsageReaders = {
  openai: openAiSubscriptionUsage,
  anthropic: anthropicSubscriptionUsage,
};

/** Reads the provider-reported windows of one stored account. */
export class SubscriptionUsage extends Context.Service<
  SubscriptionUsage,
  {
    readonly read: (
      provider: SubscriptionAccountProvider,
      accountId: string,
    ) => Effect.Effect<
      readonly SubscriptionQuotaWindow[],
      OAuthHarnessError | SubscriptionUsageRateLimited
    >;
  }
>()("memory-agent/oauth/subscription-quota/SubscriptionUsage") {
  /** Reads through the account's own client, the one its runs use, and so shares its refresh. */
  static readonly layer = Layer.effect(
    SubscriptionUsage,
    Effect.map(SubscriptionAccountClients, (clients) =>
      SubscriptionUsage.of({
        read: (provider, accountId) =>
          Effect.flatMap(clients[provider].account(accountId), (client) =>
            subscriptionUsageReaders[provider]({ client }),
          ),
      }),
    ),
  );
}

type ObservedQuota = typeof SubscriptionQuotaStatus.cases.observed.Type;

/** A provider lookup's outcome and how long it is kept before the provider is asked again. */
interface Lookup {
  readonly windows: Result.Result<
    readonly SubscriptionQuotaWindow[],
    SubscriptionQuotaUnavailableReason
  >;
  readonly holdFor: Duration.Duration;
}

/** At most one provider lookup per account per five minutes; concurrent reads share it. */
const observationTimeToLive = Duration.minutes(5);

/** A rate-limited account waits out the provider's `Retry-After`, never less than the usual hold. */
const rateLimitedHold = Option.match({
  onNone: () => observationTimeToLive,
  onSome: Duration.max(observationTimeToLive),
});

export class SubscriptionQuota extends Context.Service<
  SubscriptionQuota,
  {
    readonly accounts: (
      provider: SubscriptionAccountProvider,
    ) => Effect.Effect<SubscriptionQuotaReport, SubscriptionQuotaError>;
  }
>()("memory-agent/oauth/subscription-quota/SubscriptionQuota") {
  /**
   * Anthropic reads `/api/oauth/usage` and OpenAI Codex's `/wham/usage` (both adopted 2026-10-12,
   * see docs/subscription-quota-research.md), refreshing an expiring token first (2026-11-18);
   * a failed lookup keeps the last observation as `stale`,
   * and a rate-limited one is not repeated until the provider's `Retry-After` has passed.
   */
  static readonly layer = Layer.effect(
    SubscriptionQuota,
    Effect.gen(function* () {
      const oauthProfiles = yield* OAuthProfiles;
      const usage = yield* SubscriptionUsage;
      const lastObserved = yield* Ref.make(HashMap.empty<string, ObservedQuota>());
      const observe = Effect.fn("SubscriptionQuota.observe")(function* (
        provider: SubscriptionAccountProvider,
        accountId: string,
      ) {
        const { windows, holdFor } = yield* usage.read(provider, accountId).pipe(
          Effect.map((windows) =>
            windows.length > 0 ? Result.succeed(windows) : Result.fail("lookup_failed" as const),
          ),
          Effect.catchTag("OAuthHarnessError", (error) => {
            // A signed-out account, or one whose refresh token the provider just rejected.
            const signedOut = error.code === "not_connected" || invalidatesStoredCredential(error);
            const reason: SubscriptionQuotaUnavailableReason = signedOut
              ? "credential_expired"
              : "lookup_failed";
            return Effect.when(
              Effect.logWarning("subscription usage lookup failed").pipe(
                Effect.annotateLogs({ error: "OAuthHarnessError", code: error.code }),
              ),
              Effect.succeed(!signedOut),
            ).pipe(Effect.as(Result.fail(reason)));
          }),
          Effect.map((windows): Lookup => ({ windows, holdFor: observationTimeToLive })),
          // Asking again before the provider's wait is over would only prolong the limit.
          Effect.catchTag("SubscriptionUsageRateLimited", ({ retryAfter }) => {
            const lookup: Lookup = {
              windows: Result.fail("lookup_failed"),
              holdFor: rateLimitedHold(retryAfter),
            };
            return Effect.logWarning("subscription usage lookup rate limited").pipe(
              Effect.annotateLogs({
                error: "SubscriptionUsageRateLimited",
                holdSeconds: Duration.toSeconds(lookup.holdFor),
              }),
              Effect.as(lookup),
            );
          }),
        );
        const at = DateTime.formatIso(yield* DateTime.now);
        const quota = yield* Result.match(windows, {
          onSuccess: (observedWindows) => {
            const observed: ObservedQuota = SubscriptionQuotaStatus.cases.observed.make({
              windows: observedWindows,
              observedAt: at,
            });
            return Effect.as(Ref.update(lastObserved, HashMap.set(accountId, observed)), observed);
          },
          onFailure: (reason) =>
            Effect.map(Ref.get(lastObserved), (map) =>
              Option.match(HashMap.get(map, accountId), {
                onNone: () => SubscriptionQuotaStatus.cases.unavailable.make({ reason }),
                onSome: (previous) =>
                  SubscriptionQuotaStatus.cases.stale.make({
                    windows: previous.windows,
                    observedAt: previous.observedAt,
                    failedAt: at,
                  }),
              }),
            ),
        });
        return { quota, holdFor };
      });
      // Profile ids are unique across providers, so one cache per provider keys by id alone.
      const providerCache = (provider: SubscriptionAccountProvider) =>
        Cache.makeWith((accountId: string) => observe(provider, accountId), {
          capacity: 64,
          // An observation never fails; each one says how long it is kept.
          timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.holdFor : observationTimeToLive),
        });
      const caches = {
        openai: yield* providerCache("openai"),
        anthropic: yield* providerCache("anthropic"),
      };
      const quotaFor = (provider: SubscriptionAccountProvider, accountId: string) =>
        Effect.map(Cache.get(caches[provider], accountId), ({ quota }) => quota);
      const accounts = Effect.fn("SubscriptionQuota.accounts")(function* (
        provider: SubscriptionAccountProvider,
      ) {
        const profiles = yield* oauthProfiles
          .list(provider)
          .pipe(
            Effect.mapError((cause) =>
              SubscriptionQuotaError.make({ reason: "profiles_unreadable", cause }),
            ),
          );
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const quotas = yield* Effect.forEach(
          profiles,
          (profile) =>
            Effect.map(quotaFor(provider, profile.id), (quota) => ({
              accountId: profile.id,
              label: profile.label,
              selected: profile.selected,
              quota,
            })),
          { concurrency: 2 },
        );
        return { provider, checkedAt, accounts: quotas };
      });
      return SubscriptionQuota.of({ accounts });
    }),
  );
}
