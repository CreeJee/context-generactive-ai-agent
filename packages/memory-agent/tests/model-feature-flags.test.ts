import { HashSet } from "effect";
import { GlobalConfigFailed, GlobalConfigFailedReason } from "../src/config/global-config.ts";
import { it as effectTest } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  decideModelFeatureFlag,
  makeModelFeatureFlags,
  ModelFeatureFlagStoreFailed,
  UnknownModelFeatureCapability,
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
    expect(
      decideModelFeatureFlag(undefined, query, HashSet.fromIterable([capability])),
    ).toMatchObject({
      allowed: false,
      reasons: ["settings_missing"],
    });
    expect(decideModelFeatureFlag(enabled(), query, HashSet.empty<string>())).toMatchObject({
      allowed: false,
      reasons: ["unknown_capability"],
    });
  });

  it("requires every parent allow and lets specific denies win", () => {
    expect(
      decideModelFeatureFlag(enabled(), query, HashSet.fromIterable([capability])).allowed,
    ).toBe(true);
    for (const settings of [
      { ...enabled(), global: false },
      { ...enabled(), providers: { openai: false } },
      { ...enabled(), capabilities: { [capability]: false } },
      { ...enabled(), models: { "openai:gpt-test": { [capability]: false } } },
      { ...enabled(), routes: { "chat:openai:gpt-test": false } },
    ])
      expect(
        decideModelFeatureFlag(settings, query, HashSet.fromIterable([capability])).allowed,
      ).toBe(false);
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

  effectTest.effect("persists versioned global/provider/capability/model/route scopes", () =>
    Effect.gen(function* () {
      const { service, settings } = fixture();
      yield* service.set({ type: "global" }, true);
      yield* service.set({ type: "provider", provider: "openai" }, true);
      yield* service.set({ type: "capability", capability }, true);
      yield* service.set(
        { type: "model", provider: "openai", model: "gpt-test", capability },
        true,
      );
      yield* service.set({ type: "route", route: "chat:openai:gpt-test" }, true);
      expect(settings().modelFeatureFlags).toMatchObject({ version: 1, global: true });
      expect((yield* service.decide(query)).allowed).toBe(true);
    }),
  );

  effectTest.effect("returns typed failures for unknown capabilities and storage failures", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.result(
        fixture().service.decide({ ...query, capability: "unknown" }),
      );
      expect(Result.isFailure(unknown) && unknown.failure).toBeInstanceOf(
        UnknownModelFeatureCapability,
      );
      const failed = makeModelFeatureFlags(
        {
          read: Effect.fail(
            GlobalConfigFailed.make({
              operation: "read",
              reason: GlobalConfigFailedReason.cases.ReadFailed.make({}),
              cause: "broken",
            }),
          ),
          update: () =>
            Effect.fail(
              GlobalConfigFailed.make({
                operation: "read",
                reason: GlobalConfigFailedReason.cases.ReadFailed.make({}),
                cause: "broken",
              }),
            ),
        },
        [capability],
      );
      const result = yield* Effect.result(failed.read);
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
        ModelFeatureFlagStoreFailed,
      );
    }),
  );
});
