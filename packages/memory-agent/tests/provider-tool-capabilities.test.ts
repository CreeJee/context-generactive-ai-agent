import { memoryTool } from "@tanstack/ai-anthropic/tools";
import { OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import { Effect, Either, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  ProviderToolCapabilityRegistry,
  filterProviderTools,
  installedProviderToolModelMetadata,
  makeProviderToolCapabilityRegistry,
  providerToolDescriptors,
  type ProviderToolCapabilityRegistryApi,
} from "../src/providers/tool-capabilities.ts";

const runDefault = <A, E>(program: Effect.Effect<A, E, ProviderToolCapabilityRegistry>) =>
  Effect.runPromise(program.pipe(Effect.provide(ProviderToolCapabilityRegistry.layer)));

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.map((result) => (Either.isLeft(result) ? result.left : null)),
    ),
  );

describe("ProviderToolCapabilityRegistry", () => {
  test("contains all 18 provider-qualified tools without cross-provider collisions", () => {
    expect(providerToolDescriptors).toHaveLength(18);
    expect(new Set(providerToolDescriptors.map((entry) => entry.id)).size).toBe(18);
    expect(
      providerToolDescriptors
        .filter((entry) => entry.kind === "web_search")
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["anthropic:web_search", "openai:web_search"]);
    expect(providerToolDescriptors.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  test("preserves provider factory identity and complete capability metadata", () => {
    const descriptor = providerToolDescriptors.find((entry) => entry.id === "anthropic:memory");
    expect(descriptor).toMatchObject({
      provider: "anthropic",
      category: "memory.read_write",
      auth: ["provider_account_beta_entitlement"],
      cost: "provider_metered",
      dataAccess: ["application_memory"],
      sideEffect: "write",
      approval: "action_required",
      sandbox: ["principal_storage_required"],
      resultNormalizer: { strategy: "provider_native_preserve", preservesUnknownParts: true },
    });
    expect(descriptor?.extension.factory).toBe(memoryTool);
  });

  test("fails closed for unknown tools, unknown models, and Anthropic tools:[] models", async () => {
    const result = await runDefault(
      Effect.gen(function* () {
        const registry = yield* ProviderToolCapabilityRegistry;
        const unknownTool = yield* Effect.either(registry.get("openai:not_real"));
        const unknownModel = yield* Effect.either(
          registry.resolve({ provider: "anthropic", model: "claude-not-real" }),
        );
        const empty = yield* registry.resolve({ provider: "anthropic", model: "claude-opus-5" });
        return { unknownTool, unknownModel, empty };
      }),
    );
    expect(result.unknownTool).toMatchObject({
      _tag: "Left",
      left: { _tag: "UnknownProviderTool" },
    });
    expect(result.unknownModel).toMatchObject({
      _tag: "Left",
      left: { _tag: "UnknownProviderToolModel" },
    });
    expect(result.empty).toEqual([]);
  });

  test("resolves exact OpenAI full, subset, single, and empty capability tuples", async () => {
    const openAIModels = installedProviderToolModelMetadata.filter(
      (entry) => entry.provider === "openai",
    );
    expect(openAIModels.map((entry) => entry.model)).toEqual([...OPENAI_CHAT_MODELS]);

    const resolved = await runDefault(
      Effect.gen(function* () {
        const registry = yield* ProviderToolCapabilityRegistry;
        const ids = (model: string, accountToolKinds?: readonly string[]) =>
          Effect.map(registry.resolve({ provider: "openai", model, accountToolKinds }), (entries) =>
            entries.map((entry) => entry.id),
          );
        return {
          full: yield* ids("gpt-5.2"),
          subset: yield* ids("gpt-5-codex"),
          single: yield* ids("computer-use-preview"),
          empty: yield* ids("gpt-audio"),
          accountIntersection: yield* ids("gpt-5.2", ["web_search", "shell", "not_real"]),
        };
      }),
    );

    expect(resolved.full).toEqual([
      "openai:apply_patch",
      "openai:code_interpreter",
      "openai:computer_use",
      "openai:file_search",
      "openai:image_generation",
      "openai:local_shell",
      "openai:mcp",
      "openai:shell",
      "openai:web_search",
      "openai:web_search_preview",
    ]);
    expect(resolved.subset).toEqual([
      "openai:apply_patch",
      "openai:code_interpreter",
      "openai:file_search",
      "openai:local_shell",
      "openai:mcp",
      "openai:shell",
    ]);
    expect(resolved.single).toEqual(["openai:computer_use"]);
    expect(resolved.empty).toEqual([]);
    expect(resolved.accountIntersection).toEqual(["openai:shell", "openai:web_search"]);
  });

  test("filters and resolves deterministically, intersecting account capabilities", async () => {
    const reversed = [...providerToolDescriptors].reverse();
    expect(
      filterProviderTools(reversed, { provider: "anthropic" }).map((entry) => entry.id),
    ).toEqual(
      filterProviderTools(providerToolDescriptors, { provider: "anthropic" }).map(
        (entry) => entry.id,
      ),
    );
    const ids = await runDefault(
      Effect.gen(function* () {
        const registry = yield* ProviderToolCapabilityRegistry;
        const resolved = yield* registry.resolve({
          provider: "anthropic",
          model: "claude-opus-4-6",
          categories: ["network.search", "network.fetch", "execution.shell"],
          accountToolKinds: ["bash", "web_fetch"],
        });
        return resolved.map((entry) => entry.id);
      }),
    );
    expect(ids).toEqual(["anthropic:bash", "anthropic:web_fetch"]);
  });

  test("reports descriptor collisions as typed metadata failures", async () => {
    const first = providerToolDescriptors[0];
    const error = await failure(makeProviderToolCapabilityRegistry([first, first], []));
    expect(error).toMatchObject({
      _tag: "ProviderToolMetadataFailure",
      reason: `duplicate provider tool id: ${first.id}`,
    });
  });

  test("supports a Context.Tag Layer override", async () => {
    const override: ProviderToolCapabilityRegistryApi = {
      descriptors: [],
      get: (id) =>
        providerToolDescriptors.length > 0
          ? Effect.succeed(providerToolDescriptors[0])
          : Effect.dieMessage(id),
      filter: () => [],
      resolve: () => Effect.succeed([]),
    };
    const value = await Effect.runPromise(
      Effect.map(ProviderToolCapabilityRegistry, (registry) => registry).pipe(
        Effect.provide(Layer.succeed(ProviderToolCapabilityRegistry, override)),
      ),
    );
    expect(value).toBe(override);
  });
});
