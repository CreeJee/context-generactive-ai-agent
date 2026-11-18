import { it } from "@effect/vitest";
import { DateTime, Duration, Effect, MutableRef, Option, Result } from "effect";
import { expect } from "vite-plus/test";
import { providerProtocols, type OAuthProvider } from "../src/oauth/protocol.ts";
import {
  anthropicSubscriptionUsage,
  anthropicUsageUrl,
  openAiSubscriptionUsage,
  openAiUsageUrl,
} from "../src/oauth/subscription-usage-probe.ts";
import {
  createSubscriptionOAuthClient,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import { withOAuthTestPlatform } from "./support/platform.ts";

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : input.toString();

/** One account's client over an in-memory credential, sending every request to `fetch`. */
const accountClient = (options: {
  readonly provider: OAuthProvider;
  readonly credential: StoredCredential;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}) => {
  const stored = MutableRef.make<StoredCredential | null>(options.credential);
  return createSubscriptionOAuthClient({
    protocol: providerProtocols[options.provider],
    store: {
      read: () => Effect.sync(() => MutableRef.get(stored)),
      write: (_, credential) => Effect.sync(() => MutableRef.set(stored, credential)),
      remove: () => Effect.sync(() => MutableRef.set(stored, null)),
    },
    fetch: options.fetch,
    now: options.now ?? Date.now,
  });
};

it.effect(
  "quota lookups refresh an expiring token once through the account's client, then read the numbered named windows",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const client = yield* accountClient({
        provider: "anthropic",
        credential: { accessToken: "old", refreshToken: "old-refresh", expiresAt: 0 },
        fetch: (url, init) => {
          const target = urlOf(url);
          requests.push(
            target === anthropicUsageUrl
              ? `usage ${new Headers(init?.headers).get("authorization")}`
              : target,
          );
          return Promise.resolve(
            target === providerProtocols.anthropic.tokenUrl
              ? Response.json({
                  access_token: "new",
                  refresh_token: "new-refresh",
                  expires_in: 3600,
                })
              : Response.json({
                  five_hour: { utilization: 12.5, resets_at: "fixture" },
                  seven_day: { utilization: null, resets_at: null },
                  iguana_necktie: { utilization: 3 },
                }),
          );
        },
      });

      const lookups = yield* Effect.all(
        [anthropicSubscriptionUsage({ client }), anthropicSubscriptionUsage({ client })],
        { concurrency: "unbounded" },
      );
      expect(lookups[0]).toEqual([
        { name: "five_hour", usedPercent: 12.5, windowSeconds: 18_000, resetsAt: "fixture" },
      ]);
      expect(requests).toEqual([
        providerProtocols.anthropic.tokenUrl,
        "usage Bearer new",
        "usage Bearer new",
      ]);
    }).pipe(withOAuthTestPlatform),
);

it.effect.each([
  { retryAfter: "120", waitMillis: Option.some(120_000) },
  { retryAfter: "Sat, 31 Oct 2026 06:01:30 GMT", waitMillis: Option.some(90_000) },
  { retryAfter: null, waitMillis: Option.none() },
])(
  "a 429 fails the lookup with the provider's Retry-After ($retryAfter)",
  ({ retryAfter, waitMillis }) =>
    Effect.gen(function* () {
      const now = Date.UTC(2026, 9, 31, 6, 0, 0);
      const client = yield* accountClient({
        provider: "anthropic",
        credential: { accessToken: "fixture", refreshToken: "fixture", expiresAt: now + 3600_000 },
        fetch: () =>
          Promise.resolve(
            Response.json(
              { type: "error", error: { type: "rate_limit_error" } },
              { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } },
            ),
          ),
        now: () => now,
      });
      const outcome = yield* anthropicSubscriptionUsage({ client, now: () => now }).pipe(
        Effect.catchTag("SubscriptionUsageRateLimited", (error) =>
          Effect.fail(Option.map(error.retryAfter, Duration.toMillis)),
        ),
        Effect.result,
      );
      expect(outcome).toEqual(Result.fail(waitMillis));
    }).pipe(withOAuthTestPlatform),
);

it.effect(
  "OpenAI quota lookup reads Codex's primary and secondary windows for the stored account",
  () =>
    Effect.gen(function* () {
      const requests: { url: string; accountId: string | null }[] = [];
      const client = yield* accountClient({
        provider: "openai",
        credential: {
          accessToken: "fixture",
          refreshToken: "fixture",
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
          accountId: "account-fixture",
        },
        fetch: (url, init) => {
          requests.push({
            url: urlOf(url),
            accountId: new Headers(init?.headers).get("chatgpt-account-id"),
          });
          return Promise.resolve(
            Response.json({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 25,
                  limit_window_seconds: 18_000,
                  reset_at: 1_791_800_000,
                },
                secondary_window: null,
              },
            }),
          );
        },
      });
      const windows = yield* openAiSubscriptionUsage({ client });
      expect(windows).toEqual([
        {
          name: "primary",
          usedPercent: 25,
          windowSeconds: 18_000,
          resetsAt: "2026-10-12T10:13:20.000Z",
        },
      ]);
      expect(requests).toEqual([{ url: openAiUsageUrl, accountId: "account-fixture" }]);
    }).pipe(withOAuthTestPlatform),
);
