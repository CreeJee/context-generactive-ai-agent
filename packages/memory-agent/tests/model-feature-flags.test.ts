import { Effect, Result } from "effect";
import {
  decideModelFeatureFlag,
  makeModelFeatureFlags,
  type ModelFeatureFlagSettings,
  type Settings,
} from "memory-agent";
import { describe, expect, it } from "vite-plus/test";

const capability = "openai:web_search";
const query = {
  provider: "openai" as const,
  model: "gpt-test",
  capability,
  route: "chat:openai:gpt-test",
};
const enabled = (): ModelFeatureFlagSettings => ({
  version: 1,
  global: true,
  providers: { openai: true },
  capabilities: { [capability]: true },
  models: {},
  routes: {},
});

describe("model feature flag policy", () => {
  it("fails closed when settings are absent or the capability is unknown", () => {
    expect(decideModelFeatureFlag(undefined, query, new Set([capability]))).toMatchObject({
      allowed: false,
      reasons: ["settings_missing"],
    });
    expect(decideModelFeatureFlag(enabled(), query, new Set())).toMatchObject({
      allowed: false,
      reasons: ["unknown_capability"],
    });
  });

  it("requires every parent allow and lets specific denies win", () => {
    expect(decideModelFeatureFlag(enabled(), query, new Set([capability])).allowed).toBe(true);
    for (const settings of [
      { ...enabled(), global: false },
      { ...enabled(), providers: { openai: false } },
      { ...enabled(), capabilities: { [capability]: false } },
      { ...enabled(), models: { "openai:gpt-test": { [capability]: false } } },
      { ...enabled(), routes: { "chat:openai:gpt-test": false } },
    ])
      expect(decideModelFeatureFlag(settings, query, new Set([capability])).allowed).toBe(false);
  });
});

describe("ModelFeatureFlags service", () => {
  function fixture(initial: Settings = {}) {
    let settings = initial;
    const service = makeModelFeatureFlags(
      {
        read: Effect.sync(() => settings),
        update: (patch) => Effect.sync(() => (settings = { ...settings, ...patch })),
      },
      [capability],
    );
    return { service, settings: () => settings };
  }

  it("persists versioned global/provider/capability/model/route scopes", async () => {
    const { service, settings } = fixture();
    await Effect.runPromise(service.set({ type: "global" }, true));
    await Effect.runPromise(service.set({ type: "provider", provider: "openai" }, true));
    await Effect.runPromise(service.set({ type: "capability", capability }, true));
    await Effect.runPromise(
      service.set({ type: "model", provider: "openai", model: "gpt-test", capability }, true),
    );
    await Effect.runPromise(service.set({ type: "route", route: "chat:openai:gpt-test" }, true));
    expect(settings().modelFeatureFlags).toMatchObject({ version: 1, global: true });
    expect((await Effect.runPromise(service.decide(query))).allowed).toBe(true);
  });

  it("returns typed failures for unknown capabilities and storage defects", async () => {
    const unknown = await Effect.runPromise(
      Effect.result(fixture().service.decide({ ...query, capability: "unknown" })),
    );
    expect(Result.isFailure(unknown) && unknown.failure._tag).toBe("UnknownModelFeatureCapability");
    const failed = makeModelFeatureFlags(
      { read: Effect.die("broken"), update: () => Effect.die("broken") },
      [capability],
    );
    const result = await Effect.runPromise(Effect.result(failed.read));
    expect(Result.isFailure(result) && result.failure._tag).toBe("ModelFeatureFlagStoreFailed");
  });
});
