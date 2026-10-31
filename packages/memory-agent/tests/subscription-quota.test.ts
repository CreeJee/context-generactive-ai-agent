import { describe, expect, it } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { Database } from "../src/db/database.ts";
import { OAuthProfiles } from "../src/oauth/accounts.ts";
import {
  SubscriptionQuota,
  SubscriptionQuotaStatus,
  SubscriptionUsage,
  type SubscriptionQuotaWindow,
} from "../src/oauth/subscription-quota.ts";
import {
  SubscriptionUsageCredentialExpired,
  SubscriptionUsageRateLimited,
} from "../src/oauth/subscription-usage-probe.ts";
import { OAuthHarnessError, OAuthKeychain } from "../src/oauth/validation-harness.ts";

const fiveHour: SubscriptionQuotaWindow = {
  name: "five_hour",
  usedPercent: 37,
  windowSeconds: 18_000,
  resetsAt: "2026-10-12T05:00:00Z",
};
const expiredId = "22222222-2222-4222-8222-222222222222";

type UsageFailure = OAuthHarnessError | SubscriptionUsageRateLimited;

const quotaService = Effect.fn(function* (
  failing: Ref.Ref<UsageFailure | null>,
  calls: Ref.Ref<number>,
) {
  const database = yield* Layer.build(Database.layer(":memory:"));
  const sql = Context.get(database, SqlClient.SqlClient);
  yield* sql`INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES
    ('legacy-openai', 'openai', 'A', 1, 1),
    ('legacy-anthropic', 'anthropic', 'C', 1, 3),
    (${expiredId}, 'anthropic', 'D', 0, 4)`;
  const usage = Layer.succeed(SubscriptionUsage, {
    read: (_provider, accountId) =>
      Effect.gen(function* () {
        if (accountId === expiredId) return yield* SubscriptionUsageCredentialExpired.make({});
        yield* Ref.update(calls, (count) => count + 1);
        const failure = yield* Ref.get(failing);
        if (failure !== null) return yield* failure;
        return [fiveHour];
      }),
  });
  const services = yield* Layer.build(
    SubscriptionQuota.layer.pipe(
      Layer.provide(
        OAuthProfiles.layer.pipe(
          Layer.provide(Layer.merge(Layer.succeedContext(database), OAuthKeychain.memory)),
        ),
      ),
      Layer.provide(usage),
    ),
  );
  return yield* Effect.provideContext(SubscriptionQuota, services);
});

describe("subscription quota status", () => {
  it.effect("OpenAI accounts report the provider's observed windows", () =>
    Effect.gen(function* () {
      const quota = yield* quotaService(
        yield* Ref.make<UsageFailure | null>(null),
        yield* Ref.make(0),
      );
      const openai = yield* quota.accounts("openai");
      expect(openai.accounts.map((account) => account.quota)).toEqual([
        SubscriptionQuotaStatus.cases.observed.make({
          windows: [fiveHour],
          observedAt: "1970-01-01T00:00:00.000Z",
        }),
      ]);
    }),
  );

  it.effect(
    "Anthropic reuses an observation for five minutes, then keeps it as stale when a lookup fails",
    () =>
      Effect.gen(function* () {
        const failing = yield* Ref.make<UsageFailure | null>(null);
        const calls = yield* Ref.make(0);
        const quota = yield* quotaService(failing, calls);

        const first = yield* quota.accounts("anthropic");
        expect(first.accounts.map((account) => account.quota)).toEqual([
          SubscriptionQuotaStatus.cases.observed.make({
            windows: [fiveHour],
            observedAt: "1970-01-01T00:00:00.000Z",
          }),
          SubscriptionQuotaStatus.cases.unavailable.make({ reason: "credential_expired" }),
        ]);
        yield* quota.accounts("anthropic");
        expect(yield* Ref.get(calls)).toBe(1);

        yield* Ref.set(failing, OAuthHarnessError.fromCode("transport_unavailable", null));
        yield* TestClock.adjust("301 seconds");
        const later = yield* quota.accounts("anthropic");
        expect(later.accounts[0]?.quota).toEqual(
          SubscriptionQuotaStatus.cases.stale.make({
            windows: [fiveHour],
            observedAt: "1970-01-01T00:00:00.000Z",
            failedAt: "1970-01-01T00:05:01.000Z",
          }),
        );
        expect(yield* Ref.get(calls)).toBe(2);
      }),
  );

  it.effect("a rate-limited lookup is not repeated before the provider's Retry-After", () =>
    Effect.gen(function* () {
      const failing = yield* Ref.make<UsageFailure | null>(
        SubscriptionUsageRateLimited.make({ retryAfter: Option.some(Duration.hours(1)) }),
      );
      const calls = yield* Ref.make(0);
      const quota = yield* quotaService(failing, calls);

      yield* quota.accounts("anthropic");
      yield* Ref.set(failing, null);
      yield* TestClock.adjust("59 minutes");
      yield* quota.accounts("anthropic");
      expect(yield* Ref.get(calls)).toBe(1);

      yield* TestClock.adjust("61 seconds");
      yield* quota.accounts("anthropic");
      expect(yield* Ref.get(calls)).toBe(2);
    }),
  );
});
