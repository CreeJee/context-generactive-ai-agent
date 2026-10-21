import { it } from "@effect/vitest";
import { DateTime, Effect, Result } from "effect";
import { expect } from "vite-plus/test";
import {
  SubscriptionUsageCredentialExpired,
  anthropicSubscriptionUsage,
  anthropicSubscriptionUsageProbe,
  anthropicUsageUrl,
  openAiSubscriptionUsage,
  openAiUsageUrl,
} from "../src/oauth/subscription-usage-probe.ts";
import type { StoredCredential } from "../src/oauth/validation-harness.ts";

it.effect.each([
  { status: 200, expected: "probe" },
  { status: 401, expected: "rejected" },
] as const)("sends one usage request without refresh or retry ($status)", ({ status, expected }) =>
  Effect.gen(function* () {
    const credential: StoredCredential = {
      accessToken: "fixture",
      refreshToken: "fixture",
      expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
    };
    let writes = 0;
    const requests: Parameters<typeof fetch>[0][] = [];
    const outcome = yield* anthropicSubscriptionUsageProbe({
      store: {
        read: () => Promise.resolve(credential),
        write: () => Promise.resolve(void (writes += 1)),
        remove: () => Promise.resolve(),
      },
      fetch: (url) => {
        requests.push(url);
        return Promise.resolve(
          Response.json(
            { five_hour: { utilization: 12, resets_at: "fixture" }, extra_usage: null },
            { status },
          ),
        );
      },
    }).pipe(Effect.result);
    expect(requests).toEqual([anthropicUsageUrl]);
    expect(writes).toBe(0);
    switch (expected) {
      case "probe":
        return expect(outcome).toMatchObject({
          success: {
            refreshed: false,
            status: 200,
            fieldNames: ["five_hour", "extra_usage"],
            windows: [{ name: "five_hour", fieldNames: ["utilization", "resets_at"] }],
          },
        });
      case "rejected":
        return expect(outcome).toMatchObject({
          failure: { code: "provider_rejected", status: 401, operation: "subscription_usage" },
        });
    }
  }),
);

it.effect(
  "quota lookup reads only numbered named windows and never refreshes an expired token",
  () =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const requests: Parameters<typeof fetch>[0][] = [];
      const lookup = (expiresAt: number) =>
        anthropicSubscriptionUsage({
          store: {
            read: () =>
              Promise.resolve({ accessToken: "fixture", refreshToken: "fixture", expiresAt }),
            write: () => Promise.reject(new Error("unexpected write")),
            remove: () => Promise.resolve(),
          },
          fetch: (url) => {
            requests.push(url);
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 12.5, resets_at: "fixture" },
                seven_day: { utilization: null, resets_at: null },
                iguana_necktie: { utilization: 3 },
              }),
            );
          },
        }).pipe(Effect.result);

      expect(yield* lookup(now + 3600_000)).toMatchObject({
        success: [
          { name: "five_hour", usedPercent: 12.5, windowSeconds: 18_000, resetsAt: "fixture" },
        ],
      });
      expect(yield* lookup(now)).toEqual(Result.fail(SubscriptionUsageCredentialExpired.make()));
      expect(requests).toEqual([anthropicUsageUrl]);
    }),
);

it.effect(
  "OpenAI quota lookup reads Codex's primary and secondary windows for the stored account",
  () =>
    Effect.gen(function* () {
      const requests: { url: Parameters<typeof fetch>[0]; accountId: string | null }[] = [];
      const windows = yield* openAiSubscriptionUsage({
        store: {
          read: () =>
            Promise.resolve({
              accessToken: "fixture",
              refreshToken: "fixture",
              expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
              accountId: "account-fixture",
            }),
          write: () => Promise.reject(new Error("unexpected write")),
          remove: () => Promise.resolve(),
        },
        fetch: (url, init) => {
          requests.push({ url, accountId: new Headers(init?.headers).get("chatgpt-account-id") });
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
      expect(windows).toEqual([
        {
          name: "primary",
          usedPercent: 25,
          windowSeconds: 18_000,
          resetsAt: "2026-10-12T10:13:20.000Z",
        },
      ]);
      expect(requests).toEqual([{ url: openAiUsageUrl, accountId: "account-fixture" }]);
    }),
);
