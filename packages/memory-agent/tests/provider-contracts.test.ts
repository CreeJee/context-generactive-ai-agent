import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { ActiveProvider } from "../src/providers/active-provider.ts";
import { type ProviderId, type ProviderServices } from "../src/providers/contracts.ts";
import { ProviderRegistry, providerRegistryFrom } from "../src/providers/registry.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fakeProvider = (provider: ProviderId): ProviderServices => ({
  provider,
  auth: {
    provider,
    status: Effect.succeed({ provider, status: "signed-out" }),
    connect: Effect.succeed({ provider, status: "signed-out" }),
    cancel: Effect.succeed({ provider, status: "signed-out" }),
    disconnect: Effect.succeed({ provider, status: "signed-out" }),
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
    adapter: () => {
      throw new Error("not used");
    },
    contextWindow: () => 0,
    agentLoop: () => {
      throw new Error("not used");
    },
    runMiddleware: () => {
      throw new Error("not used");
    },
    steer: async () => "no_turn",
  },
});

describe("provider-neutral contracts", () => {
  test("migrates a legacy model selection to an explicit OpenAI provider", async () => {
    const storage = mkdtempSync(join(tmpdir(), "provider-config-"));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    mkdirSync(storage, { recursive: true });
    writeFileSync(
      join(storage, "config.json"),
      JSON.stringify({ model: "legacy-model", reasoningEffort: "high", kagiEnabled: true }),
    );

    const runtime = ManagedRuntime.make(
      GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage))),
    );
    cleanups.push(() => runtime.dispose());
    const config = await runtime.runPromise(GlobalConfig);

    expect(await runtime.runPromise(config.read)).toEqual({
      provider: "openai",
      model: "legacy-model",
      reasoningEffort: "high",
      kagiEnabled: true,
    });
    expect(JSON.parse(readFileSync(join(storage, "config.json"), "utf8"))).toEqual({
      provider: "openai",
      model: "legacy-model",
      reasoningEffort: "high",
      kagiEnabled: true,
    });
  });

  test("resolves only the requested provider and never falls back", async () => {
    const openai = fakeProvider("openai");
    const registry = providerRegistryFrom([openai]);

    expect(registry.providers).toEqual(["openai"]);
    expect(await Effect.runPromise(registry.get("openai"))).toBe(openai);
    const missing = await Effect.runPromise(Effect.result(registry.get("anthropic")));
    expect(Result.isFailure(missing) && missing.failure).toMatchObject({
      _tag: "ProviderUnavailable",
      provider: "anthropic",
    });
  });

  test("does not route a configured provider through another provider's runtime", async () => {
    const openai = fakeProvider("openai");
    const anthropic = fakeProvider("anthropic");
    const registry = providerRegistryFrom([openai, anthropic], [openai.runtime]);

    expect(await Effect.runPromise(registry.runtime("openai"))).toBe(openai.runtime);
    const missing = await Effect.runPromise(Effect.result(registry.runtime("anthropic")));
    expect(Result.isFailure(missing) && missing.failure).toMatchObject({
      _tag: "ProviderUnavailable",
      provider: "anthropic",
    });
  });

  test("resolves the saved provider and its matching runtime as one active selection", async () => {
    const storage = mkdtempSync(join(tmpdir(), "active-provider-"));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const openai = fakeProvider("openai");
    const anthropic = fakeProvider("anthropic");
    const foundation = GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)));
    const providers = ActiveProvider.layer.pipe(
      Layer.provideMerge(
        ProviderRegistry.layer([openai, anthropic], [openai.runtime, anthropic.runtime]),
      ),
      Layer.provideMerge(foundation),
    );
    const runtime = ManagedRuntime.make(providers);
    cleanups.push(() => runtime.dispose());
    const config = await runtime.runPromise(GlobalConfig);
    await runtime.runPromise(
      config.update({ provider: "anthropic", model: "claude-test", reasoningEffort: "high" }),
    );

    const active = await runtime.runPromise(ActiveProvider);
    const selection = await runtime.runPromise(active.selected);
    expect(selection).toEqual({
      provider: "anthropic",
      model: "claude-test",
      reasoningEffort: "high",
    });
    expect(selection && (await runtime.runPromise(active.runtime(selection)))).toBe(
      anthropic.runtime,
    );
  });

  test("keeps unavailable providers in the typed error channel", async () => {
    const storage = mkdtempSync(join(tmpdir(), "active-provider-missing-"));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const runtime = ManagedRuntime.make(
      ActiveProvider.layer.pipe(
        Layer.provide(ProviderRegistry.layer([fakeProvider("openai")], [])),
        Layer.provide(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
      ),
    );
    cleanups.push(() => runtime.dispose());

    const active = await runtime.runPromise(ActiveProvider);
    const missingRuntime = await runtime.runPromise(
      Effect.result(
        active.runtime({ provider: "openai", model: "test", reasoningEffort: "medium" }),
      ),
    );
    expect(Result.isFailure(missingRuntime) && missingRuntime.failure).toMatchObject({
      _tag: "ProviderUnavailable",
      provider: "openai",
    });
    expect(await runtime.runPromise(active.authFor("anthropic"))).toMatchObject({
      status: "error",
    });
  });

  test("keeps credentials outside the authentication contract", () => {
    const auth = fakeProvider("openai").auth;
    expect("token" in auth).toBe(false);
    expect("credential" in auth).toBe(false);
  });
});
