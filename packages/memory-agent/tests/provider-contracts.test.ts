import { it as effectTest } from "@effect/vitest";
import { Effect, FileSystem, Path, Result, Layer, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { ActiveProvider } from "../src/providers/active-provider.ts";
import {
  AuthConnectionState,
  ProviderId,
  ProviderUnavailable,
  type ProviderServices,
} from "../src/providers/contracts.ts";
import { ProviderRegistry, providerRegistryFrom } from "../src/providers/registry.ts";
import { withTestPlatform } from "./support/platform.ts";

const fakeProvider = (provider: ProviderId): ProviderServices => ({
  provider,
  auth: {
    provider,
    status: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
    connect: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
    cancel: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
    disconnect: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
  },
  models: {
    provider,
    list: Effect.succeed([]),
    selected: Effect.succeed(null),
    acceptsImages: () => Effect.succeed(false),
    cheapestEffort: (selection) => Effect.succeed(selection),
    select: (model) => Effect.succeed({ provider, model, reasoningEffort: "medium" }),
  },
  runtime: {
    provider,
    model: () => Effect.die(new Error("not used")),
    contextWindow: () => 0,
  },
});

describe("provider-neutral contracts", () => {
  effectTest.effect("migrates a legacy model selection to an explicit OpenAI provider", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const storage = yield* fs.makeTempDirectoryScoped({ prefix: "provider-config-" });
      yield* fs.writeFileString(
        path.join(storage, "config.json"),
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          model: "legacy-model",
          reasoningEffort: "high",
          kagiEnabled: true,
        }),
      );

      const services = yield* Layer.build(
        GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage))),
      );
      const config = yield* Effect.provideContext(GlobalConfig, services);

      expect(yield* config.read).toEqual({
        provider: "openai",
        model: "legacy-model",
        reasoningEffort: "high",
        kagiEnabled: true,
      });
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* fs.readFileString(path.join(storage, "config.json")),
        ),
      ).toEqual({
        provider: "openai",
        model: "legacy-model",
        reasoningEffort: "high",
        kagiEnabled: true,
      });
    }).pipe(withTestPlatform),
  );

  effectTest.effect("resolves only the requested provider and never falls back", () =>
    Effect.gen(function* () {
      const openai = fakeProvider("openai");
      const registry = providerRegistryFrom({ configurations: [openai] });

      expect(registry.providers).toEqual(["openai"]);
      expect(yield* registry.get("openai")).toBe(openai);
      const missing = yield* Effect.result(registry.get("anthropic"));
      expect(Result.isFailure(missing) && missing.failure).toEqual(
        ProviderUnavailable.make({ provider: "anthropic" }),
      );
    }),
  );

  effectTest.effect("does not route a configured provider through another provider's runtime", () =>
    Effect.gen(function* () {
      const openai = fakeProvider("openai");
      const anthropic = fakeProvider("anthropic");
      const registry = providerRegistryFrom({
        configurations: [openai, anthropic],
        runtimes: [openai.runtime],
      });

      expect(yield* registry.runtime("openai")).toBe(openai.runtime);
      const missing = yield* Effect.result(registry.runtime("anthropic"));
      expect(Result.isFailure(missing) && missing.failure).toEqual(
        ProviderUnavailable.make({ provider: "anthropic" }),
      );
    }),
  );

  effectTest.effect(
    "resolves the saved provider and its matching runtime as one active selection",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const storage = yield* fs.makeTempDirectoryScoped({ prefix: "active-provider-" });
        const openai = fakeProvider("openai");
        const baseAnthropic = fakeProvider("anthropic");
        const anthropic = {
          ...baseAnthropic,
          models: {
            ...baseAnthropic.models,
            selected: Effect.succeed({
              provider: "anthropic" as const,
              model: "claude-test",
              reasoningEffort: "high",
            }),
          },
        };
        const foundation = GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)));
        const providers = ActiveProvider.layer.pipe(
          Layer.provideMerge(
            ProviderRegistry.layer([openai, anthropic], [openai.runtime, anthropic.runtime]),
          ),
          Layer.provideMerge(foundation),
        );
        const services = yield* Layer.build(providers);
        const config = yield* Effect.provideContext(GlobalConfig, services);
        yield* config.update({
          provider: "anthropic",
          model: "claude-test",
          reasoningEffort: "high",
        });

        const active = yield* Effect.provideContext(ActiveProvider, services);
        const selection = yield* active.selected;
        expect(selection).toEqual({
          provider: "anthropic",
          model: "claude-test",
          reasoningEffort: "high",
        });
        expect(selection && (yield* active.runtime(selection))).toBe(anthropic.runtime);
      }).pipe(withTestPlatform),
  );

  effectTest.effect("runs a role on its own listed model without changing the selected model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storage = yield* fs.makeTempDirectoryScoped({ prefix: "role-models-" });
      const baseAnthropic = fakeProvider("anthropic");
      const anthropic = {
        ...baseAnthropic,
        models: {
          ...baseAnthropic.models,
          list: Effect.succeed([
            {
              provider: "anthropic" as const,
              id: "claude-plan",
              displayName: "Claude Plan",
              isDefault: false,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["low", "high"],
              capabilities: {
                inputModalities: ["text" as const],
                toolCalling: true,
                reasoning: true,
              },
            },
          ]),
        },
      };
      const services = yield* Layer.build(
        ActiveProvider.layer.pipe(
          Layer.provideMerge(ProviderRegistry.layer([fakeProvider("openai"), anthropic], [])),
          Layer.provideMerge(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
        ),
      );
      const config = yield* Effect.provideContext(GlobalConfig, services);
      yield* config.update({ provider: "anthropic", model: "claude-test", reasoningEffort: "low" });
      const active = yield* Effect.provideContext(ActiveProvider, services);
      const planner = {
        provider: "anthropic" as const,
        model: "claude-plan",
        reasoningEffort: "high",
      };

      yield* active.chooseFor("planner", planner);
      expect(yield* active.selectedFor("planner")).toEqual(planner);
      expect(yield* active.selectedFor("executor")).toBe(yield* active.selected);
      expect((yield* config.read).model).toBe("claude-test");

      const unlisted = yield* Effect.result(
        active.chooseFor("verifier", { ...planner, reasoningEffort: "max" }),
      );
      expect(Result.isFailure(unlisted) && unlisted.failure._tag).toBe("ModelUnavailable");
      expect(yield* active.chosenFor("verifier")).toBeNull();

      yield* active.chooseFor("planner", null);
      expect(yield* active.chosenFor("planner")).toBeNull();
    }).pipe(withTestPlatform),
  );

  effectTest.effect("keeps unavailable providers in the typed error channel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storage = yield* fs.makeTempDirectoryScoped({ prefix: "active-provider-missing-" });
      const services = yield* Layer.build(
        ActiveProvider.layer.pipe(
          Layer.provide(ProviderRegistry.layer([fakeProvider("openai")], [])),
          Layer.provide(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
        ),
      );

      const active = yield* Effect.provideContext(ActiveProvider, services);
      const missingRuntime = yield* Effect.result(
        active.runtime({ provider: "openai", model: "test", reasoningEffort: "medium" }),
      );
      expect(Result.isFailure(missingRuntime) && missingRuntime.failure).toEqual(
        ProviderUnavailable.make({ provider: "openai" }),
      );
      expect(yield* active.authFor("anthropic")).toEqual(
        AuthConnectionState.error({
          provider: "anthropic",
          message: "공급자 로그인 상태를 확인하지 못했습니다.",
        }),
      );
    }).pipe(withTestPlatform),
  );
});
