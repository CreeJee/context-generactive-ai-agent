import { withTestPlatform } from "./support/platform.ts";
import { it as effectTest } from "@effect/vitest";
import { Effect, Result, Layer, MutableRef } from "effect";
import { describe, expect } from "vite-plus/test";
import { makeModelFeatureFlags } from "../src/providers/model-feature-flags.ts";
import { matchGolden, subscriptionToolRequestBodies } from "./support/requests.ts";
import {
  ProviderToolCapabilityRegistry,
  makeProviderToolCapabilityRegistry,
  providerToolDescriptors,
  type ProviderToolMetadataFailure,
} from "../src/providers/tool-capabilities.ts";
import {
  ProviderToolFactoryOptionsFailure,
  ProviderToolNotExposed,
  ProviderToolOptionsViolation,
  ProviderToolPolicy,
  ProviderToolRuntime,
  makeProviderToolPolicy,
  type ProviderToolRequest,
  type ProviderToolPolicyContext,
} from "../src/providers/tool-policy.ts";

const defaultPolicyLayer = ProviderToolPolicy.layer.pipe(
  Layer.provide(ProviderToolCapabilityRegistry.layer),
);
const run = Effect.fn("providerPolicy.run")(function* <A, E>(
  effect: Effect.Effect<A, E, ProviderToolPolicy>,
  layer: Layer.Layer<ProviderToolPolicy, ProviderToolMetadataFailure> = defaultPolicyLayer,
) {
  const services = yield* Layer.build(layer);
  return yield* Effect.provideContext(effect, services);
});
const errorOf = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.result,
    Effect.map((either) => (Result.isFailure(either) ? either.failure : null)),
  );
const basePolicy = (
  overrides: Partial<ProviderToolPolicyContext> = {},
): ProviderToolPolicyContext => ({
  provider: "openai",
  model: "gpt-5.2",
  accountToolKinds: ["web_search", "local_shell", "apply_patch"],
  app: { allowNetwork: true },
  user: { allowNetwork: true },
  ...overrides,
});
const sandbox = { isolatedCompute: true, isolatedDesktop: false };

describe("ProviderToolPolicy", () => {
  effectTest.live(
    "exposes allowed read-only tools deterministically and intersects account capability",
    () =>
      Effect.gen(function* () {
        const first = yield* run(
          Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(basePolicy())),
        );
        const second = yield* run(
          Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(basePolicy())),
        );
        expect(first).toEqual(second);
        expect(first.tools.map((tool) => tool.id)).toEqual(["openai:web_search"]);
        expect(first.tools[0]).toMatchObject({ risk: "read_only", requiresApproval: false });
      }).pipe(withTestPlatform),
  );

  effectTest.effect("reads feature flags fresh on every exposure", () =>
    Effect.gen(function* () {
      const allowed = MutableRef.make(true);
      const flags = makeModelFeatureFlags(
        {
          read: Effect.sync(() => ({
            modelFeatureFlags: {
              version: 1 as const,
              global: MutableRef.get(allowed),
              providers: { openai: MutableRef.get(allowed) },
              capabilities: { "openai:web_search": MutableRef.get(allowed) },
              models: {},
              routes: {},
            },
          })),
          update: (patch) => Effect.succeed(patch),
        },
        providerToolDescriptors.map((descriptor) => descriptor.id),
      );
      const registry = yield* makeProviderToolCapabilityRegistry({});
      const policy = makeProviderToolPolicy({
        registry: registry,
        config: {},
        featureFlags: flags,
      });
      expect((yield* policy.expose(basePolicy())).tools.map((tool) => tool.id)).toEqual([
        "openai:web_search",
      ]);
      MutableRef.set(allowed, false);
      expect((yield* policy.expose(basePolicy())).tools).toEqual([]);
    }).pipe(withTestPlatform),
  );

  effectTest.live("does not expose local high-risk tools without trusted authority", () =>
    Effect.gen(function* () {
      const enabled = basePolicy({
        accountToolKinds: ["web_search", "local_shell", "apply_patch", "computer_use"],
        app: { allowNetwork: true, allowHighRisk: true },
        user: { allowNetwork: true, allowHighRisk: true },
      });
      const openAI = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(enabled)),
      );
      const anthropic = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          policy.expose({
            ...enabled,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            accountToolKinds: ["computer_use", "memory"],
          }),
        ),
      );
      expect(openAI.tools.map((tool) => tool.id)).toEqual(["openai:web_search"]);
      expect(anthropic.tools).toEqual([]);
    }).pipe(withTestPlatform),
  );

  effectTest.live("trusted profiles expose only tools with matching authority", () =>
    Effect.gen(function* () {
      const enabled = basePolicy({
        accountToolKinds: ["local_shell", "apply_patch", "computer_use"],
        app: { allowHighRisk: true },
        user: { allowHighRisk: true },
      });
      const workspaceOnly = ProviderToolPolicy.layerWithConfig({
        sandbox: { ...sandbox, isolatedCompute: false },
      }).pipe(Layer.provide(ProviderToolCapabilityRegistry.layer));
      const compute = ProviderToolPolicy.layerWithConfig({ sandbox }).pipe(
        Layer.provide(ProviderToolCapabilityRegistry.layer),
      );
      const desktop = ProviderToolPolicy.layerWithConfig({
        sandbox: { isolatedCompute: false, isolatedDesktop: true },
      }).pipe(Layer.provide(ProviderToolCapabilityRegistry.layer));
      const decisions = yield* Effect.forEach(
        [workspaceOnly, compute, desktop],
        (layer) =>
          run(
            Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(enabled)),
            layer,
          ),
        { concurrency: "unbounded" },
      );
      expect(decisions.map((decision) => decision.tools.map((tool) => tool.id))).toEqual([
        ["openai:apply_patch"],
        ["openai:apply_patch", "openai:local_shell"],
        ["openai:apply_patch", "openai:computer_use"],
      ]);
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "principal storage authority exposes memory without granting desktop authority",
    () =>
      Effect.gen(function* () {
        const context = basePolicy({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          accountToolKinds: ["computer_use", "memory"],
          app: { allowHighRisk: true },
          user: { allowHighRisk: true },
        });
        const layer = ProviderToolPolicy.layerWithConfig({ principalStorage: true }).pipe(
          Layer.provide(ProviderToolCapabilityRegistry.layer),
        );
        const decision = yield* run(
          Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(context)),
          layer,
        );
        expect(decision.tools.map((tool) => tool.id)).toEqual(["anthropic:memory"]);
      }).pipe(withTestPlatform),
  );
});

const runtimeLayer = ProviderToolRuntime.layer.pipe(
  Layer.provide(defaultPolicyLayer),
  Layer.provide(ProviderToolCapabilityRegistry.layer),
);
const runRuntime = Effect.fn("providerPolicy.runRuntime")(function* <A, E>(
  effect: Effect.Effect<A, E, ProviderToolRuntime>,
) {
  const services = yield* Layer.build(runtimeLayer);
  return yield* Effect.provideContext(effect, services);
});

describe("ProviderToolRuntime", () => {
  effectTest.live(
    "composes allowed OpenAI and Anthropic hosted factories in deterministic order",
    () =>
      Effect.gen(function* () {
        const openai = yield* runRuntime(
          Effect.flatMap(ProviderToolRuntime, (runtime) =>
            runtime.compose(basePolicy({ accountToolKinds: ["web_search"] }), [
              { id: "openai:web_search", config: { type: "web_search" } },
            ]),
          ),
        );
        const anthropic = yield* runRuntime(
          Effect.flatMap(ProviderToolRuntime, (runtime) =>
            runtime.compose(
              {
                provider: "anthropic",
                model: "claude-opus-4-6",
                accountToolKinds: ["web_fetch"],
                app: { allowNetwork: true },
                user: { allowNetwork: true },
              },
              [{ id: "anthropic:web_fetch", config: {} }],
            ),
          ),
        );
        expect(openai.map((entry) => entry.id)).toEqual(["openai:web_search"]);
        expect(anthropic.map((entry) => entry.id)).toEqual(["anthropic:web_fetch"]);
        // The Effect AI tool reaches the provider as the TanStack one made from the same request.
        yield* matchGolden("./__golden__/provider-tool-policy.json")(
          subscriptionToolRequestBodies([...openai, ...anthropic].map((entry) => entry.modelTool)),
        );
      }).pipe(withTestPlatform),
  );

  effectTest.live("rejects representative hosted and caller-loop factory option violations", () =>
    Effect.gen(function* () {
      const invalid = [
        [
          basePolicy({ accountToolKinds: ["web_search"] }),
          { id: "openai:web_search", config: { type: "web_search", unexpected: true } },
        ],
        [
          basePolicy({ accountToolKinds: ["local_shell"] }),
          { id: "openai:local_shell", config: { type: "local_shell" } },
        ],
        [
          {
            provider: "anthropic" as const,
            model: "claude-opus-4-6",
            accountToolKinds: ["web_search"],
            app: { allowNetwork: true },
            user: { allowNetwork: true },
          },
          { id: "anthropic:web_search", config: { type: "wrong_version" } },
        ],
        [
          {
            provider: "anthropic" as const,
            model: "claude-opus-4-6",
            accountToolKinds: ["bash"],
            app: { allowHighRisk: true },
            user: { allowHighRisk: true },
          },
          { id: "anthropic:bash", config: { type: "bash_20250124", unexpected: true } },
        ],
      ] as const;
      const errors = yield* runRuntime(
        Effect.flatMap(ProviderToolRuntime, (runtime) =>
          Effect.forEach(invalid, ([policy, request]) =>
            errorOf(runtime.compose(policy, [request])),
          ),
        ),
      );
      expect(errors).toEqual(errors.map(() => expect.any(ProviderToolOptionsViolation)));
      expect(errors).toEqual(
        errors.map(() => expect.objectContaining({ reason: "invalid_factory_options" })),
      );
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "rejects requested IDs that exposure did not allow and defaults to no tools",
    () =>
      Effect.gen(function* () {
        const result = yield* runRuntime(
          Effect.flatMap(ProviderToolRuntime, (runtime) =>
            Effect.all([
              runtime.compose(basePolicy(), []),
              errorOf(
                runtime.compose(basePolicy({ accountToolKinds: ["web_search"] }), [
                  {
                    id: "openai:file_search",
                    config: { type: "file_search", vector_store_ids: ["vs_1"] },
                  },
                ]),
              ),
            ]),
          ),
        );
        expect(result[0]).toEqual([]);
        expect(result[1]).toBeInstanceOf(ProviderToolNotExposed);
      }).pipe(withTestPlatform),
  );

  effectTest.live("rejects mismatched providers and unknown composition fields", () =>
    Effect.gen(function* () {
      const unknownFields = {
        id: "openai:web_search",
        config: { type: "web_search" },
      } satisfies ProviderToolRequest;
      Reflect.set(unknownFields, "unexpected", true);
      const [unknown, mismatch] = yield* runRuntime(
        Effect.flatMap(ProviderToolRuntime, (runtime) =>
          Effect.all([
            errorOf(runtime.compose(basePolicy(), [unknownFields])),
            errorOf(runtime.compose(basePolicy(), [{ id: "anthropic:web_fetch", config: {} }])),
          ]),
        ),
      );
      expect([unknown, mismatch]).toEqual([
        ProviderToolFactoryOptionsFailure.make({
          toolId: "openai:web_search",
          reason: "invalid_request",
        }),
        ProviderToolFactoryOptionsFailure.make({
          toolId: "anthropic:web_fetch",
          reason: "provider_mismatch",
        }),
      ]);
    }).pipe(withTestPlatform),
  );
});
