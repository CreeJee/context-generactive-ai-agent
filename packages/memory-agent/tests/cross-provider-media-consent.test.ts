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

  it("distinguishes disabled, ask and always for an exact pair and capability", async () => {
    const memory = config();
    const service = makeCrossProviderMediaConsent(memory.api);
    expect((await Effect.runPromise(service.decide(pair))).mode).toBe("disabled");
    await Effect.runPromise(service.set(pair, "ask"));
    expect(await Effect.runPromise(service.decide(pair))).toMatchObject({
      mode: "ask",
      requiresApproval: true,
      allowedWithoutPrompt: false,
    });
    await Effect.runPromise(service.set(pair, "always"));
    expect(await Effect.runPromise(service.decide(pair))).toMatchObject({
      mode: "always",
      requiresApproval: false,
      allowedWithoutPrompt: true,
    });
  });

  it("does not broaden consent to another capability or provider pair", async () => {
    const service = makeCrossProviderMediaConsent(config().api);
    await Effect.runPromise(service.set(pair, "always"));
    expect(
      (await Effect.runPromise(service.decide({ ...pair, capability: "media.video.generate" })))
        .mode,
    ).toBe("disabled");
    expect(
      (
        await Effect.runPromise(
          service.decide({ ...pair, initiatorProvider: "openai", executorProvider: "anthropic" }),
        )
      ).mode,
    ).toBe("disabled");
  });

  it("keeps read failures typed and therefore fail-closed", async () => {
    const service = makeCrossProviderMediaConsent({
      read: Effect.die("broken store"),
      update: () => Effect.die("broken store"),
    });
    const error = await Effect.runPromise(Effect.flip(service.decide(pair)));
    expect(error).toBeInstanceOf(CrossProviderMediaConsentStoreFailed);
    expect(error.operation).toBe("read");
  });
});
