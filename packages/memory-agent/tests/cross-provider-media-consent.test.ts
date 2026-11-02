import { it as effectTest } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import {
  decideCrossProviderMediaConsent,
  makeCrossProviderMediaConsent,
  type Settings,
} from "../src/index.ts";
import { Effect, MutableRef } from "effect";

const pair = {
  initiatorProvider: "anthropic" as const,
  executorProvider: "openai" as const,
  capability: "media.image.generate",
};
const config = (initial: Settings = {}) => {
  const settings = MutableRef.make(initial);
  return {
    api: {
      read: Effect.sync(() => MutableRef.get(settings)),
      update: (patch: Partial<Settings>) =>
        Effect.sync(() =>
          MutableRef.updateAndGet(settings, (current) => ({ ...current, ...patch })),
        ),
    },
    get: () => MutableRef.get(settings),
  };
};

describe("CrossProviderMediaConsent", () => {
  it("denies a missing cross-provider setting without inferring consent from login", () => {
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
});
