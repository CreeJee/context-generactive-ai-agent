import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Fiber, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { makeModelFeatureFlags } from "../src/providers/model-feature-flags.ts";
import {
  ProviderToolCapabilityRegistry,
  makeProviderToolCapabilityRegistry,
  providerToolDescriptors,
  type ProviderToolCapabilityRegistryApi,
  type ProviderToolMetadataFailure,
} from "../src/providers/tool-capabilities.ts";
import {
  ProviderToolPolicy,
  ProviderToolRuntime,
  makeProviderToolPolicy,
  makeProviderToolRuntime,
  normalizeProviderToolUsage,
  providerToolFactoryValidatorIds,
  type ProviderToolExecutionRevalidationInput,
  type ProviderToolFactoryRequest,
  type ProviderToolPolicyApi,
  type ProviderToolPolicyContext,
  type ProviderToolRuntimeApi,
} from "../src/providers/tool-policy.ts";

const defaultPolicyLayer = ProviderToolPolicy.layer.pipe(
  Layer.provide(ProviderToolCapabilityRegistry.layer),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, ProviderToolPolicy>,
  layer: Layer.Layer<ProviderToolPolicy, ProviderToolMetadataFailure> = defaultPolicyLayer,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
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
const temporaryDirectory = (prefix = "provider-policy-") =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
  test("exposes allowed read-only tools deterministically and intersects account capability", async () => {
    const first = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(basePolicy())),
    );
    const second = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(basePolicy())),
    );
    expect(first).toEqual(second);
    expect(first.tools.map((tool) => tool.id)).toEqual(["openai:web_search"]);
    expect(first.tools[0]).toMatchObject({ risk: "read_only", requiresApproval: false });
  });

  test("uses the same fresh feature flag policy for exposure and execution", async () => {
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
    const registry = await Effect.runPromise(makeProviderToolCapabilityRegistry());
    const policy = makeProviderToolPolicy(registry, {}, flags);
    expect(
      (await Effect.runPromise(policy.expose(basePolicy()))).tools.map((tool) => tool.id),
    ).toEqual(["openai:web_search"]);
    allowed = false;
    expect((await Effect.runPromise(policy.expose(basePolicy()))).tools).toEqual([]);
    const denied = await Effect.runPromise(
      errorOf(
        policy.revalidateExecution({
          policy: basePolicy(),
          toolId: "openai:web_search",
          provider: "openai",
          kind: "web_search",
          options: {},
          approval: "not_requested",
        }),
      ),
    );
    expect(denied).toMatchObject({
      _tag: "ProviderToolPolicyDenied",
      reason: "feature_flag_disabled",
    });
  });

  test("does not expose local high-risk tools without trusted authority", async () => {
    const enabled = basePolicy({
      accountToolKinds: ["web_search", "local_shell", "apply_patch", "computer_use"],
      app: { allowNetwork: true, allowHighRisk: true },
      user: { allowNetwork: true, allowHighRisk: true },
    });
    const openAI = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(enabled)),
    );
    const anthropic = await run(
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
  });

  test("trusted profiles expose only tools with matching authority and still require approval", async () => {
    const root = temporaryDirectory();
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
    const decisions = await Promise.all(
      [workspaceOnly, compute, desktop].map((layer) =>
        run(
          Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(enabled)),
          layer,
        ),
      ),
    );
    expect(decisions.map((decision) => decision.tools.map((tool) => tool.id))).toEqual([
      ["openai:apply_patch"],
      ["openai:apply_patch", "openai:local_shell"],
      ["openai:apply_patch", "openai:computer_use"],
    ]);

    const required = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) =>
        errorOf(
          policy.revalidateExecution(execution({ policy: enabled, approval: "not_requested" })),
        ),
      ),
      trustedPolicyLayer(root),
    );
    expect(required).toMatchObject({ _tag: "ProviderToolApprovalRequired" });
  });

  test("principal storage authority exposes memory without granting desktop authority", async () => {
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
    const decision = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) => policy.expose(context)),
      layer,
    );
    expect(decision.tools.map((tool) => tool.id)).toEqual(["anthropic:memory"]);
  });

  test.each([
    ["denied", "ProviderToolApprovalDenied"],
    ["cancelled", "ProviderToolApprovalCancelled"],
  ] as const)("returns typed %s approval outcomes", async (approval, tag) => {
    const value = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) =>
        errorOf(policy.revalidateExecution(execution({ approval }))),
      ),
    );
    expect(value).toMatchObject({ _tag: tag });
  });

  test("trusted configuration grants local authority and canonicalizes its root", async () => {
    const root = temporaryDirectory();
    const decision = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) => policy.revalidateExecution(execution())),
      trustedPolicyLayer(`${root}/.`),
    );
    expect(decision).toMatchObject({
      workspaceRoot: root,
      tool: { id: "openai:local_shell", requiresApproval: true },
    });
  });

  test("default production Layer permits provider-hosted work without local authority", async () => {
    const decision = await run(
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
  });

  test("default production Layer fails closed for app-managed tools", async () => {
    const error = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) =>
        errorOf(policy.revalidateExecution(execution())),
      ),
    );
    expect(error).toMatchObject({
      _tag: "ProviderToolSandboxViolation",
      reason: "trusted_profile_required",
    });
  });

  test("forged sandbox and workspace fields cannot grant authority", async () => {
    const root = temporaryDirectory();
    const options: ProviderToolExecutionRevalidationInput["options"] = {};
    Reflect.set(options, "workspaceRoot", root);
    Reflect.set(options, "sandbox", sandbox(root));
    const error = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) =>
        errorOf(policy.revalidateExecution(execution({ options }))),
      ),
    );
    expect(error).toMatchObject({
      _tag: "ProviderToolOptionsViolation",
      reason: "unknown_policy_option",
    });
  });

  test("fails closed for unsupported models, tools, model capability, and account capability", async () => {
    const cases = [
      execution({
        policy: basePolicy({ model: "not-a-model" }),
        toolId: "openai:web_search",
        kind: "web_search",
      }),
      execution({ toolId: "openai:not-real", kind: "not-real" }),
      execution({
        policy: basePolicy({ model: "computer-use-preview" }),
        toolId: "openai:web_search",
        kind: "web_search",
      }),
      execution({ policy: basePolicy({ accountToolKinds: [] }) }),
    ];
    const errors = await Promise.all(
      cases.map((input) =>
        run(
          Effect.flatMap(ProviderToolPolicy, (policy) =>
            errorOf(policy.revalidateExecution(input)),
          ),
        ),
      ),
    );
    expect(errors).toMatchObject([
      { reason: "unknown_model" },
      { reason: "unknown_tool" },
      { reason: "model_unsupported" },
      { _tag: "ProviderToolCapabilityDenied", reason: "account_unsupported" },
    ]);
  });

  test("rejects tampered provider, kind, and policy options", async () => {
    const kind = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) =>
        errorOf(policy.revalidateExecution(execution({ kind: "web_search" }))),
      ),
    );
    const provider = await run(
      Effect.flatMap(ProviderToolPolicy, (policy) =>
        errorOf(policy.revalidateExecution(execution({ provider: "anthropic" }))),
      ),
    );
    expect(kind).toMatchObject({ _tag: "ProviderToolOptionsViolation" });
    expect(provider).toMatchObject({ _tag: "ProviderToolOptionsViolation" });
  });

  test("checks traversal, absolute paths, symlinks, and credentials against the trusted root", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory("provider-policy-outside-");
    writeFileSync(join(outside, "data.txt"), "not read");
    symlinkSync(outside, join(root, "linked"));
    const inputs = [
      { paths: [{ path: "../x", access: "read" as const, target: "file" as const }] },
      { paths: [{ path: join(root, "x"), access: "read" as const, target: "file" as const }] },
      {
        paths: [{ path: "linked/data.txt", access: "read" as const, target: "file" as const }],
      },
      { paths: [{ path: ".env", access: "read" as const, target: "file" as const }] },
    ];
    const errors = await Promise.all(
      inputs.map((options) =>
        run(
          Effect.flatMap(ProviderToolPolicy, (policy) =>
            errorOf(policy.revalidateExecution(execution({ options }))),
          ),
          trustedPolicyLayer(root),
        ),
      ),
    );
    expect(errors).toMatchObject([
      { _tag: "ProviderToolPathViolation", reason: "invalid_path" },
      { _tag: "ProviderToolPathViolation", reason: "absolute_path" },
      { _tag: "ProviderToolPathViolation", reason: "symlink" },
      { _tag: "ProviderToolPathViolation", reason: "credential_path" },
    ]);
  });

  test("enforces trusted isolation, environment, network, and finite maxima", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "work"));
    const restrictedLayer = trustedPolicyLayer(root);
    const inputs = [
      { networkRequested: true },
      { environmentNames: ["TOKEN"] },
      { timeoutMs: 5_001 },
      { maxProcesses: Number.POSITIVE_INFINITY },
    ];
    const errors = await Promise.all(
      inputs.map((options) =>
        run(
          Effect.flatMap(ProviderToolPolicy, (policy) =>
            errorOf(policy.revalidateExecution(execution({ options }))),
          ),
          restrictedLayer,
        ),
      ),
    );
    const unisolated = ProviderToolPolicy.layerWithConfig({
      sandbox: { ...sandbox(root), isolatedCompute: false },
    }).pipe(Layer.provide(ProviderToolCapabilityRegistry.layer));
    errors.push(
      await run(
        Effect.flatMap(ProviderToolPolicy, (policy) =>
          errorOf(policy.revalidateExecution(execution())),
        ),
        unisolated,
      ),
    );
    expect(errors).toMatchObject([
      { _tag: "ProviderToolSandboxViolation", reason: "network_denied" },
      { _tag: "ProviderToolSandboxViolation", reason: "environment_denied" },
      { _tag: "ProviderToolOptionsViolation", reason: "timeout_limit_invalid" },
      { _tag: "ProviderToolOptionsViolation", reason: "processes_limit_invalid" },
      { _tag: "ProviderToolSandboxViolation", reason: "isolated_compute_required" },
    ]);
  });

  test("supports a deterministic test Layer override", async () => {
    const override: ProviderToolPolicyApi = {
      expose: () => Effect.succeed({ tools: [] }),
      revalidateExecution: () => Effect.die("unused"),
    };
    const value = await Effect.runPromise(
      Effect.map(ProviderToolPolicy, (service) => service).pipe(
        Effect.provide(ProviderToolPolicy.layerFrom(override)),
      ),
    );
    expect(value).toBe(override);
  });
});

const runtimeLayer = ProviderToolRuntime.layer.pipe(
  Layer.provide(defaultPolicyLayer),
  Layer.provide(ProviderToolCapabilityRegistry.layer),
);
const runRuntime = <A, E>(effect: Effect.Effect<A, E, ProviderToolRuntime>) =>
  Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer)));

describe("ProviderToolRuntime", () => {
  test("composes allowed OpenAI and Anthropic hosted factories in deterministic order", async () => {
    const openai = await runRuntime(
      Effect.flatMap(ProviderToolRuntime, (runtime) =>
        runtime.compose(basePolicy({ accountToolKinds: ["web_search"] }), [
          { id: "openai:web_search", args: [{ type: "web_search" }] },
        ]),
      ),
    );
    const anthropic = await runRuntime(
      Effect.flatMap(ProviderToolRuntime, (runtime) =>
        runtime.compose(
          {
            provider: "anthropic",
            model: "claude-opus-4-6",
            accountToolKinds: ["web_fetch"],
            app: { allowNetwork: true },
            user: { allowNetwork: true },
          },
          [{ id: "anthropic:web_fetch", args: [] }],
        ),
      ),
    );
    expect(openai.map((entry) => entry.id)).toEqual(["openai:web_search"]);
    expect(anthropic.map((entry) => entry.id)).toEqual(["anthropic:web_fetch"]);
    expect(openai[0]?.tool).toBeDefined();
    expect(anthropic[0]?.tool).toBeDefined();
  });

  test("has a runtime factory validator for every installed provider tool", () => {
    expect(providerToolFactoryValidatorIds).toEqual(
      providerToolDescriptors.map((descriptor) => descriptor.id).toSorted(),
    );
    expect(providerToolFactoryValidatorIds).toHaveLength(18);
  });

  /* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Deliberately malformed runtime inputs must bypass the public compile-time request union. */
  test("rejects representative hosted and caller-loop factory option violations", async () => {
    const invalid = [
      [
        basePolicy({ accountToolKinds: ["web_search"] }),
        { id: "openai:web_search", args: [{ type: "web_search", unexpected: true }] },
      ],
      [
        basePolicy({ accountToolKinds: ["local_shell"] }),
        { id: "openai:local_shell", args: [{ type: "local_shell" }] },
      ],
      [
        {
          provider: "anthropic" as const,
          model: "claude-opus-4-6",
          accountToolKinds: ["web_search"],
          app: { allowNetwork: true },
          user: { allowNetwork: true },
        },
        { id: "anthropic:web_search", args: [{ type: "wrong_version" }] },
      ],
      [
        {
          provider: "anthropic" as const,
          model: "claude-opus-4-6",
          accountToolKinds: ["bash"],
          app: { allowHighRisk: true },
          user: { allowHighRisk: true },
        },
        { id: "anthropic:bash", args: [{ type: "bash_20250124", unexpected: true }] },
      ],
    ] as const;
    const errors = await runRuntime(
      Effect.flatMap(ProviderToolRuntime, (runtime) =>
        Effect.all(
          invalid.map(([policy, request]) =>
            errorOf(runtime.compose(policy, [request as unknown as ProviderToolFactoryRequest])),
          ),
        ),
      ),
    );
    expect(errors).toEqual(
      errors.map(() =>
        expect.objectContaining({
          _tag: "ProviderToolOptionsViolation",
          reason: "invalid_factory_options",
        }),
      ),
    );
  });
  /* oxlint-enable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */

  test("rejects requested IDs that exposure did not allow and defaults to no tools", async () => {
    const result = await runRuntime(
      Effect.flatMap(ProviderToolRuntime, (runtime) =>
        Effect.all([
          runtime.compose(basePolicy(), []),
          errorOf(
            runtime.compose(basePolicy({ accountToolKinds: ["web_search"] }), [
              {
                id: "openai:file_search",
                args: [{ type: "file_search", vector_store_ids: ["vs_1"] }],
              },
            ]),
          ),
        ]),
      ),
    );
    expect(result[0]).toEqual([]);
    expect(result[1]).toMatchObject({ _tag: "ProviderToolNotExposed" });
  });

  test("turns synchronous factory throws into typed failures without changing arguments", async () => {
    const original = providerToolDescriptors.find((entry) => entry.id === "openai:web_search");
    if (original === undefined) throw new Error("missing fixture descriptor");
    const expected: Parameters<typeof original.extension.factory>[0] = { type: "web_search" };
    let received: unknown;
    const throwing: typeof original = {
      ...original,
      extension: {
        factory: (value) => {
          received = value;
          throw new Error("factory failed");
        },
      },
    };
    const registry: ProviderToolCapabilityRegistryApi = {
      descriptors: [throwing],
      get: () => Effect.succeed(throwing),
      filter: () => [throwing],
      resolve: () => Effect.succeed([throwing]),
    };
    const policy: ProviderToolPolicyApi = {
      expose: () =>
        Effect.succeed({
          tools: [
            {
              id: throwing.id,
              provider: throwing.provider,
              kind: throwing.kind,
              category: throwing.category,
              risk: "read_only",
              requiresApproval: false,
              sandbox: throwing.sandbox,
            },
          ],
        }),
      revalidateExecution: () => Effect.die("unused"),
    };
    const error = await Effect.runPromise(
      errorOf(
        makeProviderToolRuntime(registry, policy).compose(basePolicy(), [
          { id: "openai:web_search", args: [expected] },
        ]),
      ),
    );
    expect(received).toBe(expected);
    expect(error).toMatchObject({ _tag: "ProviderToolFactoryFailure" });
  });

  test("preserves raw usage identity and exact attribution without estimating cost", async () => {
    const raw = { variant: "future", nested: { untouched: true } };
    const usage = {
      input_tokens: 3,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      server_tool_use: { web_search_requests: 1 },
      future_usage: 99,
    };
    const result = await runRuntime(
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
    expect(normalizeProviderToolUsage(usage)?.raw).toBe(usage);
  });

  test("normalizes common states and preserves unknown provider result kinds losslessly", async () => {
    const raw = Object.freeze({ type: "future_provider_event", payload: { value: 42 } });
    const lifecycle: unknown[] = [];
    const result = await runRuntime(
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
  });

  test("emits ordered terminal lifecycle states for failure and interruption", async () => {
    const failedLifecycle: string[] = [];
    let rejectedReleases = 0;
    const rejection = await runRuntime(
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
    expect(rejection).toMatchObject({ _tag: "ProviderToolOperationFailure" });
    expect(rejectedReleases).toBe(1);
    expect(failedLifecycle).toEqual(["running", "failed"]);

    let aborted = false;
    let cancelledReleases = 0;
    const cancelledLifecycle: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
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
            operation: ({ signal, progress }) =>
              new Promise<{ raw: null }>((resolve) => {
                signal.addEventListener("abort", () => {
                  aborted = true;
                  progress({ raw: "before-cancel", kind: "progress" });
                  setTimeout(() => progress({ raw: "too-late", kind: "progress" }), 5);
                  resolve({ raw: null });
                });
              }),
            onLifecycle: (event) => {
              cancelledLifecycle.push(event.status);
            },
          }),
        );
        yield* Effect.sleep("10 millis");
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(runtimeLayer)),
    );
    expect(aborted).toBe(true);
    expect(cancelledReleases).toBe(1);
    const callbacksAtScopeEnd = cancelledLifecycle.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cancelledLifecycle.at(-1)).toBe("cancelled");
    expect(cancelledLifecycle).toHaveLength(callbacksAtScopeEnd);
  });

  test("keeps release failures in the typed lease error channel", async () => {
    const error = await runRuntime(
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
    expect(error).toMatchObject({ _tag: "ProviderToolLeaseFailure", phase: "release" });
  });

  test("rejects mismatched providers and unknown composition fields", async () => {
    const unknownFields = {
      id: "openai:web_search",
      args: [{ type: "web_search" }],
    } satisfies ProviderToolFactoryRequest;
    Reflect.set(unknownFields, "unexpected", true);
    const [unknown, mismatch] = await runRuntime(
      Effect.flatMap(ProviderToolRuntime, (runtime) =>
        Effect.all([
          errorOf(runtime.compose(basePolicy(), [unknownFields])),
          errorOf(runtime.compose(basePolicy(), [{ id: "anthropic:web_fetch", args: [] }])),
        ]),
      ),
    );
    expect(unknown).toMatchObject({
      _tag: "ProviderToolFactoryOptionsFailure",
      reason: "invalid_request",
    });
    expect(mismatch).toMatchObject({
      _tag: "ProviderToolFactoryOptionsFailure",
      reason: "provider_mismatch",
    });
  });

  test("returns caller-loop action metadata without executing the supplied operation", async () => {
    const root = temporaryDirectory();
    const policyLayer = trustedPolicyLayer(root);
    const layer = ProviderToolRuntime.layer.pipe(
      Layer.provide(policyLayer),
      Layer.provide(ProviderToolCapabilityRegistry.layer),
    );
    let executed = false;
    const result = await Effect.runPromise(
      Effect.flatMap(ProviderToolRuntime, (runtime) =>
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
      ).pipe(Effect.provide(layer)),
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
  });

  test("supports a runtime Layer override", async () => {
    const override: ProviderToolRuntimeApi = {
      compose: () => Effect.succeed([]),
      execute: () => Effect.die("unused"),
    };
    const value = await Effect.runPromise(
      Effect.map(ProviderToolRuntime, (runtime) => runtime).pipe(
        Effect.provide(ProviderToolRuntime.layerFrom(override)),
      ),
    );
    expect(value).toBe(override);
  });
});
