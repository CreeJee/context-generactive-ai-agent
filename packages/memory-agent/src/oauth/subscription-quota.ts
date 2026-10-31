import {
  Cache,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Layer,
  Ref,
  Result,
  Schema,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { SubscriptionAccountProvider } from "../providers/contracts.ts";
import { OAuthProfiles } from "./accounts.ts";
import {
  SubscriptionQuotaStatus,
  type SubscriptionQuotaReport,
  type SubscriptionQuotaWindow,
} from "./contracts.ts";
import {
  anthropicSubscriptionUsage,
  openAiSubscriptionUsage,
  type SubscriptionUsageCredentialExpired,
} from "./subscription-usage-probe.ts";
import { OAuthKeychain, type OAuthHarnessError } from "./validation-harness.ts";

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
      OAuthHarnessError | SubscriptionUsageCredentialExpired
    >;
  }
>()("memory-agent/oauth/subscription-quota/SubscriptionUsage") {
  static readonly layer = Layer.effect(
    SubscriptionUsage,
    Effect.gen(function* () {
      const vault = yield* OAuthKeychain;
      const platform = yield* Effect.context<
        Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
      >();
      return SubscriptionUsage.of({
        read: (provider, accountId) =>
          // Only listed accounts are read, and their ids are valid profile ids.
          Effect.orDie(vault.profileStore(accountId)).pipe(
            Effect.flatMap((store) => subscriptionUsageReaders[provider]({ store })),
            Effect.provideContext(platform),
          ),
      });
    }),
  );
}

type ObservedQuota = typeof SubscriptionQuotaStatus.cases.observed.Type;

/** At most one provider lookup per account per minute; concurrent reads share it. */
const observationTimeToLive = Duration.minutes(1);

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
   * see docs/subscription-quota-research.md); a failed lookup keeps the last observation as `stale`.
   */
  static readonly layer = Layer.effect(
    SubscriptionQuota,
    Effect.gen(function* () {
      const oauthProfiles = yield* OAuthProfiles;
      const usage = yield* SubscriptionUsage;
      const lastObserved = yield* Ref.make<ReadonlyMap<string, ObservedQuota>>(new Map());
      const observe = Effect.fn("SubscriptionQuota.observe")(function* (
        provider: SubscriptionAccountProvider,
        accountId: string,
      ) {
        const windows = yield* usage.read(provider, accountId).pipe(
          Effect.map((windows) =>
            windows.length > 0 ? Result.succeed(windows) : Result.fail("lookup_failed" as const),
          ),
          Effect.catchTags({
            SubscriptionUsageCredentialExpired: () =>
              Effect.succeed(Result.fail("credential_expired" as const)),
            OAuthHarnessError: (error) =>
              Effect.logWarning("subscription usage lookup failed").pipe(
                Effect.annotateLogs({ error: "OAuthHarnessError", code: error.code }),
                Effect.as(Result.fail("lookup_failed" as const)),
              ),
          }),
        );
        const at = DateTime.formatIso(yield* DateTime.now);
        return yield* Result.match(windows, {
          onSuccess: (observedWindows) => {
            const observed: ObservedQuota = SubscriptionQuotaStatus.cases.observed.make({
              windows: observedWindows,
              observedAt: at,
            });
            return Effect.as(
              Ref.update(lastObserved, (map) => new Map(map).set(accountId, observed)),
              observed,
            );
          },
          onFailure: (reason) =>
            Effect.map(Ref.get(lastObserved), (map) => {
              const previous = map.get(accountId);
              return previous === undefined
                ? SubscriptionQuotaStatus.cases.unavailable.make({ reason })
                : SubscriptionQuotaStatus.cases.stale.make({
                    windows: previous.windows,
                    observedAt: previous.observedAt,
                    failedAt: at,
                  });
            }),
        });
      });
      // Profile ids are unique across providers, so one cache per provider keys by id alone.
      const providerCache = (provider: SubscriptionAccountProvider) =>
        Cache.make({
          capacity: 64,
          timeToLive: observationTimeToLive,
          lookup: (accountId: string) => observe(provider, accountId),
        });
      const caches = {
        openai: yield* providerCache("openai"),
        anthropic: yield* providerCache("anthropic"),
      };
      const quotaFor = (provider: SubscriptionAccountProvider, accountId: string) =>
        Cache.get(caches[provider], accountId);
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
