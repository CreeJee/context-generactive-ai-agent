import { it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { expect } from "vite-plus/test";
import {
  anthropicSubscriptionUsageProbe,
  anthropicUsageUrl,
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
