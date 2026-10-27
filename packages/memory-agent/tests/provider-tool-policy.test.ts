import { withTestPlatform } from "./support/platform.ts";
import { it as effectTest } from "@effect/vitest";
import { Deferred, Effect, Result, Fiber, FileSystem, Layer, Path } from "effect";
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
  ProviderToolApprovalCancelled,
  ProviderToolApprovalDenied,
  ProviderToolApprovalRequired,
  ProviderToolCapabilityDenied,
  ProviderToolFactoryOptionsFailure,
  ProviderToolLeaseFailure,
  ProviderToolNotExposed,
  ProviderToolOperationFailure,
  ProviderToolOptionsViolation,
  ProviderToolPathViolation,
  ProviderToolPolicy,
  ProviderToolPolicyDenied,
  ProviderToolRuntime,
  ProviderToolSandboxViolation,
  makeProviderToolPolicy,
  normalizeProviderToolUsage,
  type ProviderToolExecutionRevalidationInput,
  type ProviderToolRequest,
  type ProviderToolPolicyApi,
  type ProviderToolPolicyContext,
  type ProviderToolRuntimeApi,
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
const execution = (
  overrides: Partial<ProviderToolExecutionRevalidationInput> = {},
): ProviderToolExecutionRevalidationInput => ({
  policy: basePolicy({ app: { allowHighRisk: true }, user: { allowHighRisk: true } }),
  toolId: "openai:local_shell",
  provider: "openai",
  kind: "local_shell",
  options: {},
  approval: "granted",
  ...overrides,
});
const temporaryDirectory = Effect.fn("providerPolicy.temporaryDirectory")(function* (
  prefix: string = "provider-policy-",
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }));
});
const sandbox = (root: string) => ({
  workspaceRoot: root,
  isolatedCompute: true,
  isolatedDesktop: false,
  network: "none" as const,
  environment: "allowlisted_names" as const,
  allowedEnvironmentNames: ["PATH"],
  limits: {
    timeoutMs: 5_000,
    maxOutputBytes: 1_000,
    maxMemoryBytes: 10_000_000,
    maxProcesses: 2,
  },
});
const trustedPolicyLayer = (root: string) =>
  ProviderToolPolicy.layerWithConfig({ sandbox: sandbox(root) }).pipe(
    Layer.provide(ProviderToolCapabilityRegistry.layer),
  );

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

  effectTest.effect("uses the same fresh feature flag policy for exposure and execution", () =>
    Effect.gen(function* () {
      let allowed = true;
      const flags = makeModelFeatureFlags(
        {
          read: Effect.sync(() => ({
            modelFeatureFlags: {
              version: 1 as const,
              global: allowed,
              providers: { openai: allowed },
              capabilities: { "openai:web_search": allowed },
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
      allowed = false;
      expect((yield* policy.expose(basePolicy())).tools).toEqual([]);
      const denied = yield* errorOf(
        policy.revalidateExecution({
          policy: basePolicy(),
          toolId: "openai:web_search",
          provider: "openai",
          kind: "web_search",
          options: {},
          approval: "not_requested",
        }),
      );
      expect(denied).toBeInstanceOf(ProviderToolPolicyDenied);
      expect(denied).toMatchObject({ reason: "feature_flag_disabled" });
    }),
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

  effectTest.live(
    "trusted profiles expose only tools with matching authority and still require approval",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory();
        const enabled = basePolicy({
          accountToolKinds: ["local_shell", "apply_patch", "computer_use"],
          app: { allowHighRisk: true },
          user: { allowHighRisk: true },
        });
        const workspaceOnly = ProviderToolPolicy.layerWithConfig({
          sandbox: { ...sandbox(root), isolatedCompute: false },
        }).pipe(Layer.provide(ProviderToolCapabilityRegistry.layer));
        const compute = trustedPolicyLayer(root);
        const desktop = ProviderToolPolicy.layerWithConfig({
          sandbox: { ...sandbox(root), isolatedCompute: false, isolatedDesktop: true },
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
        const required = yield* run(
          Effect.flatMap(ProviderToolPolicy, (policy) =>
            errorOf(
              policy.revalidateExecution(execution({ policy: enabled, approval: "not_requested" })),
            ),
          ),
          trustedPolicyLayer(root),
        );
        expect(required).toBeInstanceOf(ProviderToolApprovalRequired);
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

  effectTest.live.each([
    ["denied", ProviderToolApprovalDenied],
    ["cancelled", ProviderToolApprovalCancelled],
  ] as const)("returns typed %s approval outcomes", ([approval, outcome]) =>
    Effect.gen(function* () {
      const value = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          errorOf(policy.revalidateExecution(execution({ approval }))),
        ),
      );
      expect(value).toBeInstanceOf(outcome);
    }).pipe(withTestPlatform),
  );

  effectTest.live("trusted configuration grants local authority and canonicalizes its root", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory();
      const decision = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) => policy.revalidateExecution(execution())),
        trustedPolicyLayer(`${root}/.`),
      );
      expect(decision).toMatchObject({
        workspaceRoot: root,
        tool: { id: "openai:local_shell", requiresApproval: true },
      });
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "default production Layer permits provider-hosted work without local authority",
    () =>
      Effect.gen(function* () {
        const decision = yield* run(
          Effect.flatMap(ProviderToolPolicy, (policy) =>
            policy.revalidateExecution(
              execution({
                policy: basePolicy(),
                toolId: "openai:web_search",
                kind: "web_search",
                options: { networkRequested: true },
                approval: "not_requested",
              }),
            ),
          ),
        );
        expect(decision).toMatchObject({
          workspaceRoot: null,
          tool: { id: "openai:web_search" },
        });
      }).pipe(withTestPlatform),
  );

  effectTest.live("default production Layer fails closed for app-managed tools", () =>
    Effect.gen(function* () {
      const error = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          errorOf(policy.revalidateExecution(execution())),
        ),
      );
      expect(error).toBeInstanceOf(ProviderToolSandboxViolation);
      expect(error).toMatchObject({ reason: "trusted_profile_required" });
    }).pipe(withTestPlatform),
  );

  effectTest.live("forged sandbox and workspace fields cannot grant authority", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory();
      const options: ProviderToolExecutionRevalidationInput["options"] = {};
      Reflect.set(options, "workspaceRoot", root);
      Reflect.set(options, "sandbox", sandbox(root));
      const error = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          errorOf(policy.revalidateExecution(execution({ options }))),
        ),
      );
      expect(error).toBeInstanceOf(ProviderToolOptionsViolation);
      expect(error).toMatchObject({ reason: "unknown_policy_option" });
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "fails closed for unsupported models, tools, model capability, and account capability",
    () =>
      Effect.gen(function* () {
        const cases = [
          execution({
            policy: basePolicy({ model: "not-a-model" }),
            toolId: "openai:web_search",
            kind: "web_search",
          }),
          execution({ toolId: "openai:not-real", kind: "not-real" }),
          execution({
            policy: basePolicy({ model: "gpt-5-codex" }),
            toolId: "openai:web_search",
            kind: "web_search",
          }),
          execution({ policy: basePolicy({ accountToolKinds: [] }) }),
        ];
        const errors = yield* Effect.forEach(
          cases,
          (input) =>
            run(
              Effect.flatMap(ProviderToolPolicy, (policy) =>
                errorOf(policy.revalidateExecution(input)),
              ),
            ),
          { concurrency: "unbounded" },
        );
        expect(errors).toMatchObject([
          { reason: "unknown_model" },
          { reason: "unknown_tool" },
          { reason: "model_unsupported" },
          { reason: "account_unsupported" },
        ]);
        expect(errors[3]).toBeInstanceOf(ProviderToolCapabilityDenied);
      }).pipe(withTestPlatform),
  );

  effectTest.live("rejects tampered provider, kind, and policy options", () =>
    Effect.gen(function* () {
      const kind = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          errorOf(policy.revalidateExecution(execution({ kind: "web_search" }))),
        ),
      );
      const provider = yield* run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          errorOf(policy.revalidateExecution(execution({ provider: "anthropic" }))),
        ),
      );
      expect(kind).toBeInstanceOf(ProviderToolOptionsViolation);
      expect(provider).toBeInstanceOf(ProviderToolOptionsViolation);
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "checks traversal, absolute paths, symlinks, and credentials against the trusted root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* temporaryDirectory();
        const outside = yield* temporaryDirectory("provider-policy-outside-");
        yield* fs.writeFileString(path.join(outside, "data.txt"), "not read");
        yield* fs.symlink(outside, path.join(root, "linked"));
        const inputs = [
          { paths: [{ path: "../x", access: "read" as const, target: "file" as const }] },
          {
            paths: [
              { path: path.join(root, "x"), access: "read" as const, target: "file" as const },
            ],
          },
          {
            paths: [{ path: "linked/data.txt", access: "read" as const, target: "file" as const }],
          },
          { paths: [{ path: ".env", access: "read" as const, target: "file" as const }] },
        ];
        const errors = yield* Effect.forEach(
          inputs,
          (options) =>
            run(
              Effect.flatMap(ProviderToolPolicy, (policy) =>
                errorOf(policy.revalidateExecution(execution({ options }))),
              ),
              trustedPolicyLayer(root),
            ),
          { concurrency: "unbounded" },
        );
        expect(errors).toEqual(errors.map(() => expect.any(ProviderToolPathViolation)));
        expect(errors).toMatchObject([
          { reason: "invalid_path" },
          { reason: "absolute_path" },
          { reason: "symlink" },
          { reason: "credential_path" },
        ]);
      }).pipe(withTestPlatform),
  );

  effectTest.live("enforces trusted isolation, environment, network, and finite maxima", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* temporaryDirectory();
      yield* fs.makeDirectory(path.join(root, "work"));
      const restrictedLayer = trustedPolicyLayer(root);
      const inputs = [
        { networkRequested: true },
        { environmentNames: ["TOKEN"] },
        { timeoutMs: 5_001 },
        { maxProcesses: Number.POSITIVE_INFINITY },
      ];
      const errors = yield* Effect.forEach(
        inputs,
        (options) =>
          run(
            Effect.flatMap(ProviderToolPolicy, (policy) =>
              errorOf(policy.revalidateExecution(execution({ options }))),
            ),
            restrictedLayer,
          ),
        { concurrency: "unbounded" },
      );
      const unisolated = ProviderToolPolicy.layerWithConfig({
        sandbox: { ...sandbox(root), isolatedCompute: false },
      }).pipe(Layer.provide(ProviderToolCapabilityRegistry.layer));
      errors.push(
        yield* run(
          Effect.flatMap(ProviderToolPolicy, (policy) =>
            errorOf(policy.revalidateExecution(execution())),
          ),
          unisolated,
        ),
      );
      expect(errors).toEqual([
        expect.any(ProviderToolSandboxViolation),
        expect.any(ProviderToolSandboxViolation),
        expect.any(ProviderToolOptionsViolation),
        expect.any(ProviderToolOptionsViolation),
        expect.any(ProviderToolSandboxViolation),
      ]);
      expect(errors).toMatchObject([
        { reason: "network_denied" },
        { reason: "environment_denied" },
        { reason: "timeout_limit_invalid" },
        { reason: "processes_limit_invalid" },
        { reason: "isolated_compute_required" },
      ]);
    }).pipe(withTestPlatform),
  );

  effectTest.effect("supports a deterministic test Layer override", () =>
    Effect.gen(function* () {
      const override: ProviderToolPolicyApi = {
        expose: () => Effect.succeed({ tools: [] }),
        revalidateExecution: () => Effect.die("unused"),
      };
      const value = yield* Effect.map(ProviderToolPolicy, (service) => service).pipe(
        // Test entry point owns this Layer and its resource scope.
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(ProviderToolPolicy.layerFrom(override));
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      );
      expect(value).toBe(override);
    }),
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

  /* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Deliberately malformed runtime inputs must bypass the public compile-time request union. */
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
  /* oxlint-enable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */

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

  effectTest.live(
    "preserves raw usage identity and exact attribution without estimating cost",
    () =>
      Effect.gen(function* () {
        const raw = { variant: "future", nested: { untouched: true } };
        const usage = {
          input_tokens: 3,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          server_tool_use: { web_search_requests: 1 },
          future_usage: 99,
        };
        const result = yield* runRuntime(
          Effect.flatMap(ProviderToolRuntime, (runtime) =>
            runtime.execute({
              policy: basePolicy({ accountToolKinds: ["web_search"] }),
              toolId: "openai:web_search",
              kind: "web_search",
              accountId: "account-1",
              runId: "run-1",
              options: { networkRequested: true },
              approval: "not_requested",
              operation: () => Promise.resolve({ raw, usage }),
            }),
          ),
        );
        expect(result).toMatchObject({
          provider: "openai",
          toolId: "openai:web_search",
          model: "gpt-5.2",
          accountId: "account-1",
          execution: "provider_hosted",
          status: "succeeded",
          unknownKind: false,
          usage: {
            attribution: {
              provider: "openai",
              model: "gpt-5.2",
              accountId: "account-1",
              toolId: "openai:web_search",
              runId: "run-1",
            },
            inputTokens: 3,
            outputTokens: 5,
            cacheReadTokens: 2,
            serverToolRequests: { web_search_requests: 1 },
          },
        });
        expect(result.raw).toBe(raw);
        expect(result.usage?.raw).toBe(usage);
        expect(result.cost).toBeUndefined();
        expect(normalizeProviderToolUsage({ raw: usage })?.raw).toBe(usage);
      }).pipe(withTestPlatform),
  );

  effectTest.live(
    "normalizes common states and preserves unknown provider result kinds losslessly",
    () =>
      Effect.gen(function* () {
        const raw = Object.freeze({ type: "future_provider_event", payload: { value: 42 } });
        const lifecycle: unknown[] = [];
        const result = yield* runRuntime(
          Effect.flatMap(ProviderToolRuntime, (runtime) =>
            runtime.execute({
              policy: basePolicy({ accountToolKinds: ["web_search"] }),
              toolId: "openai:web_search",
              kind: "web_search",
              accountId: "account-unknown",
              runId: "run-unknown",
              options: { networkRequested: true },
              approval: "not_requested",
              operation: ({ progress }) => {
                progress({ raw: { pending: true }, kind: "approval_required" });
                return { raw, kind: "future_provider_event" };
              },
              onLifecycle: (event) => {
                lifecycle.push(event);
              },
            }),
          ),
        );
        expect(result).toMatchObject({
          status: "succeeded",
          providerKind: "future_provider_event",
          unknownKind: true,
        });
        expect(result.raw).toBe(raw);
        expect(lifecycle).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: "approval-required", unknownKind: false }),
            expect.objectContaining({
              status: "succeeded",
              providerKind: "future_provider_event",
              unknownKind: true,
            }),
          ]),
        );
      }).pipe(withTestPlatform),
  );

  effectTest.live("emits ordered terminal lifecycle states for failure and interruption", () =>
    Effect.gen(function* () {
      const failedLifecycle: string[] = [];
      let rejectedReleases = 0;
      const rejection = yield* runRuntime(
        Effect.flatMap(ProviderToolRuntime, (runtime) =>
          errorOf(
            runtime.execute({
              policy: basePolicy({ accountToolKinds: ["web_search"] }),
              toolId: "openai:web_search",
              kind: "web_search",
              accountId: "account-1",
              runId: "run-1",
              options: { networkRequested: true },
              approval: "not_requested",
              acquire: () => ({
                release: () => {
                  rejectedReleases++;
                },
              }),
              operation: () => Promise.reject(new Error("provider rejected")),
              onLifecycle: (event) => {
                failedLifecycle.push(event.status);
              },
            }),
          ),
        ),
      );
      expect(rejection).toBeInstanceOf(ProviderToolOperationFailure);
      expect(rejectedReleases).toBe(1);
      expect(failedLifecycle).toEqual(["running", "failed"]);
      let aborted = false;
      let cancelledReleases = 0;
      const cancelledLifecycle: string[] = [];
      const operationContext = yield* Effect.context<never>();
      const operationStarted = yield* Deferred.make<void>();
      const operationCompleted = yield* Deferred.make<{ raw: null }>();
      const lateAllowed = yield* Deferred.make<void>();
      let lateProgress = () => {};
      const lateFiber = yield* Effect.forkChild(
        Deferred.await(lateAllowed).pipe(Effect.andThen(Effect.sync(() => lateProgress()))),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* ProviderToolRuntime;
        const fiber = yield* Effect.forkChild(
          runtime.execute({
            policy: basePolicy({ accountToolKinds: ["web_search"] }),
            toolId: "openai:web_search",
            kind: "web_search",
            accountId: "account-1",
            runId: "run-1",
            options: { networkRequested: true },
            approval: "not_requested",
            acquire: () => ({
              release: () => {
                cancelledReleases++;
              },
            }),
            operation: ({ signal, progress }) => {
              signal.addEventListener("abort", () => {
                aborted = true;
                progress({ raw: "before-cancel", kind: "progress" });
                lateProgress = () => progress({ raw: "too-late", kind: "progress" });
                Deferred.doneUnsafe(operationCompleted, Effect.succeed({ raw: null }));
              });
              Deferred.doneUnsafe(operationStarted, Effect.void);
              // The SDK operation returns a Promise; execution cancellation settles its Deferred.
              return Effect.runPromiseWith(operationContext)(Deferred.await(operationCompleted));
            },
            onLifecycle: (event) => {
              cancelledLifecycle.push(event.status);
            },
          }),
        );
        yield* Deferred.await(operationStarted);
        yield* Fiber.interrupt(fiber);
        // Test entry point owns this Layer and its resource scope.
      }).pipe(
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(runtimeLayer);
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      );
      expect(aborted).toBe(true);
      expect(cancelledReleases).toBe(1);
      const callbacksAtScopeEnd = cancelledLifecycle.length;
      yield* Deferred.succeed(lateAllowed, undefined);
      yield* Fiber.join(lateFiber);
      expect(cancelledLifecycle.at(-1)).toBe("cancelled");
      expect(cancelledLifecycle).toHaveLength(callbacksAtScopeEnd);
    }).pipe(withTestPlatform),
  );

  effectTest.live("keeps release failures in the typed lease error channel", () =>
    Effect.gen(function* () {
      const error = yield* runRuntime(
        Effect.flatMap(ProviderToolRuntime, (runtime) =>
          errorOf(
            runtime.execute({
              policy: basePolicy({ accountToolKinds: ["web_search"] }),
              toolId: "openai:web_search",
              kind: "web_search",
              accountId: "account-release",
              runId: "run-release",
              options: { networkRequested: true },
              approval: "not_requested",
              acquire: () => ({
                release: () => Promise.reject(new Error("release failed")),
              }),
              operation: () => ({ raw: "completed" }),
            }),
          ),
        ),
      );
      expect(error).toBeInstanceOf(ProviderToolLeaseFailure);
      expect(error).toMatchObject({ phase: "release" });
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

  effectTest.effect(
    "returns caller-loop action metadata without executing the supplied operation",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory();
        const policyLayer = trustedPolicyLayer(root);
        const layer = ProviderToolRuntime.layer.pipe(
          Layer.provide(policyLayer),
          Layer.provide(ProviderToolCapabilityRegistry.layer),
        );
        let executed = false;
        const result = yield* Effect.flatMap(
          ProviderToolRuntime,
          (runtime) =>
            runtime.execute({
              policy: basePolicy({
                accountToolKinds: ["local_shell"],
                app: { allowHighRisk: true },
                user: { allowHighRisk: true },
              }),
              toolId: "openai:local_shell",
              kind: "local_shell",
              accountId: "account-local",
              runId: "run-local",
              options: {},
              approval: "granted",
              operation: () => {
                executed = true;
                return { raw: "must-not-run" };
              },
            }),
          // Test entry point owns this Layer and its resource scope.
        ).pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(layer);
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        );
        expect(executed).toBe(false);
        expect(result).toMatchObject({
          status: "pending",
          runId: "run-local",
          action: {
            mode: "future_executor",
            provider: "openai",
            toolId: "openai:local_shell",
            kind: "local_shell",
            workspaceRoot: root,
          },
        });
      }).pipe(withTestPlatform),
  );

  effectTest.effect("supports a runtime Layer override", () =>
    Effect.gen(function* () {
      const override: ProviderToolRuntimeApi = {
        compose: () => Effect.succeed([]),
        execute: () => Effect.die("unused"),
      };
      const value = yield* Effect.map(ProviderToolRuntime, (runtime) => runtime).pipe(
        // Test entry point owns this Layer and its resource scope.
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(ProviderToolRuntime.layerFrom(override));
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      );
      expect(value).toBe(override);
    }),
  );
});
