import { Layer } from "effect";
import { it as effectTest } from "@effect/vitest";
import { optionalProperty } from "../src/optional-property.ts";
import { Effect, Result } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  ProviderToolCapabilityRegistry,
  ProviderToolMetadataFailure,
  ProviderToolMetadataFailureReason,
  UnknownProviderTool,
  UnknownProviderToolModel,
  filterProviderTools,
  makeProviderToolCapabilityRegistry,
  providerToolDescriptors,
} from "../src/providers/tool-capabilities.ts";

const withDefault = Effect.fnUntraced(function* <A, E>(
  program: Effect.Effect<A, E, ProviderToolCapabilityRegistry>,
) {
  const services = yield* Layer.build(ProviderToolCapabilityRegistry.layer);
  return yield* Effect.provideContext(program, services);
}, Effect.scoped);

describe("ProviderToolCapabilityRegistry", () => {
  effectTest.effect(
    "fails closed for unknown tools and unknown models, and resolves no tools for tools:[] models",
    () =>
      Effect.gen(function* () {
        const result = yield* withDefault(
          Effect.gen(function* () {
            const registry = yield* ProviderToolCapabilityRegistry;
            const unknownTool = yield* Effect.result(registry.get("openai:not_real"));
            const unknownModel = yield* Effect.result(
              registry.resolve({ provider: "anthropic", model: "claude-not-real" }),
            );
            const empty = yield* registry.resolve({
              provider: "openai",
              model: "gpt-6-sol-pro",
            });
            return { unknownTool, unknownModel, empty };
          }),
        );
        expect(Result.isFailure(result.unknownTool) && result.unknownTool.failure).toBeInstanceOf(
          UnknownProviderTool,
        );
        expect(Result.isFailure(result.unknownModel) && result.unknownModel.failure).toBeInstanceOf(
          UnknownProviderToolModel,
        );
        expect(result.empty).toEqual([]);
      }),
  );

  effectTest.effect("resolves exact OpenAI full, subset, single, and empty capability tuples", () =>
    Effect.gen(function* () {
      const resolved = yield* withDefault(
        Effect.gen(function* () {
          const registry = yield* ProviderToolCapabilityRegistry;
          const ids = (model: string, accountToolKinds?: readonly string[]) =>
            Effect.map(
              registry.resolve({
                provider: "openai",
                model,
                ...optionalProperty("accountToolKinds", accountToolKinds),
              }),
              (entries) => entries.map((entry) => entry.id),
            );
          return {
            full: yield* ids("gpt-5.2"),
            subset: yield* ids("gpt-5-codex"),
            single: yield* ids("gpt-4o-search-preview"),
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
      expect(resolved.single).toEqual(["openai:web_search_preview"]);
      expect(resolved.empty).toEqual([]);
      expect(resolved.accountIntersection).toEqual(["openai:shell", "openai:web_search"]);
    }),
  );

  effectTest.effect(
    "filters and resolves deterministically, intersecting account capabilities",
    () =>
      Effect.gen(function* () {
        const reversed = [...providerToolDescriptors].reverse();
        expect(
          filterProviderTools(reversed, { provider: "anthropic" }).map((entry) => entry.id),
        ).toEqual(
          filterProviderTools(providerToolDescriptors, { provider: "anthropic" }).map(
            (entry) => entry.id,
          ),
        );
        const ids = yield* withDefault(
          Effect.gen(function* () {
            const registry = yield* ProviderToolCapabilityRegistry;
            const resolved = yield* registry.resolve({
              provider: "anthropic",
              model: "claude-opus-4-6",
              accountToolKinds: ["bash", "web_fetch"],
            });
            return resolved.map((entry) => entry.id);
          }),
        );
        expect(ids).toEqual(["anthropic:bash", "anthropic:web_fetch"]);
      }),
  );

  effectTest.effect("reports descriptor collisions as typed metadata failures", () =>
    Effect.gen(function* () {
      const first = providerToolDescriptors[0];
      const error = yield* Effect.flip(
        makeProviderToolCapabilityRegistry({ descriptors: [first, first], models: [] }),
      );
      expect(error).toEqual(
        ProviderToolMetadataFailure.make({
          reason: ProviderToolMetadataFailureReason.cases.DuplicateTool.make({ id: first.id }),
        }),
      );
    }),
  );
});
