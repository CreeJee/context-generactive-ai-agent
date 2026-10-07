import { it as effectTest } from "@effect/vitest";
// Test/benchmark SDK boundary uses native Promise callbacks, I/O fixtures and synchronous codec assertions.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vite-plus/test";
import {
  CrossProviderMediaConsentStoreFailed,
  decideCrossProviderMediaConsent,
  makeCrossProviderMediaConsent,
  type Settings,
} from "../src/index.ts";
import { Effect } from "effect";

const pair = {
  initiatorProvider: "anthropic" as const,
  executorProvider: "openai" as const,
  capability: "media.image.generate",
};
const config = (initial: Settings = {}) => {
  let settings = initial;
  return {
    api: {
      read: Effect.sync(() => settings),
      update: (patch: Partial<Settings>) =>
        Effect.sync(() => (settings = { ...settings, ...patch })),
    },
    get: () => settings,
  };
};

describe("CrossProviderMediaConsent", () => {
  it("denies a missing cross-provider setting without inferring consent from login", async () => {
    const decision = decideCrossProviderMediaConsent(undefined, pair);
    expect(decision).toMatchObject({
      crossProvider: true,
      mode: "disabled",
      allowedWithoutPrompt: false,
      requiresApproval: false,
      settingsVersion: null,
    });
    expect(decision.reasons).toContain("settings_missing");
  });

  it("does not gate same-provider media routes", () => {
    expect(
      decideCrossProviderMediaConsent(undefined, {
        ...pair,
        initiatorProvider: "openai",
      }),
    ).toMatchObject({ crossProvider: false, mode: "always", allowedWithoutPrompt: true });
  });

  effectTest.effect("distinguishes disabled, ask and always for an exact pair and capability", () =>
    Effect.gen(function* () {
      const memory = config();
      const service = makeCrossProviderMediaConsent(memory.api);
      expect((yield* service.decide(pair)).mode).toBe("disabled");
      yield* service.set(pair, "ask");
      expect(yield* service.decide(pair)).toMatchObject({
        mode: "ask",
        requiresApproval: true,
        allowedWithoutPrompt: false,
      });
      yield* service.set(pair, "always");
      expect(yield* service.decide(pair)).toMatchObject({
        mode: "always",
        requiresApproval: false,
        allowedWithoutPrompt: true,
      });
    }),
  );

  effectTest.effect("does not broaden consent to another capability or provider pair", () =>
    Effect.gen(function* () {
      const service = makeCrossProviderMediaConsent(config().api);
      yield* service.set(pair, "always");
      expect((yield* service.decide({ ...pair, capability: "media.video.generate" })).mode).toBe(
        "disabled",
      );
      expect(
        (yield* service.decide({
          ...pair,
          initiatorProvider: "openai",
          executorProvider: "anthropic",
        })).mode,
      ).toBe("disabled");
    }),
  );

  effectTest.effect("keeps read failures typed and therefore fail-closed", () =>
    Effect.gen(function* () {
      const service = makeCrossProviderMediaConsent({
        read: Effect.die("broken store"),
        update: () => Effect.die("broken store"),
      });
      const error = yield* Effect.flip(service.decide(pair));
      expect(error).toBeInstanceOf(CrossProviderMediaConsentStoreFailed);
      expect(error.operation).toBe("read");
    }),
  );
});
