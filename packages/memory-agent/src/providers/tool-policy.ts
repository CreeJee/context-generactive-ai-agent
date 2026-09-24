import { isAbsolute, resolve } from "node:path";
import { Cause, Context, Data, Effect, Result, Exit, Layer } from "effect";
import { canonicalPath, isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import {
  ModelFeatureFlags,
  type ModelFeatureFlagStoreFailed,
  type ModelFeatureFlagsApi,
  type UnknownModelFeatureCapability,
} from "./model-feature-flags.ts";
import {
  ProviderToolCapabilityRegistry,
  providerToolDescriptors,
  type AnyProviderToolDescriptor,
  type ProviderToolCategory,
  type ProviderToolExecution,
  type ProviderToolId,
  type ProviderToolKind,
  type ProviderToolProvider,
} from "./tool-capabilities.ts";

export type ProviderToolRisk = "read_only" | "elevated" | "high";
export type ProviderToolApprovalState = "not_requested" | "granted" | "denied" | "cancelled";
export interface ProviderToolPrincipalPolicy {
  readonly enabledToolIds?: readonly ProviderToolId[];
  readonly disabledToolIds?: readonly ProviderToolId[];
  readonly allowedCategories?: readonly ProviderToolCategory[];
  readonly allowNetwork?: boolean;
  readonly allowProviderFiles?: boolean;
  readonly allowHighRisk?: boolean;
}
export interface ProviderToolPolicyContext {
  readonly provider: ProviderToolProvider;
  readonly model: string;
  /** Account entitlements/capabilities only; never credentials. */
  readonly accountToolKinds: readonly string[];
  readonly app: ProviderToolPrincipalPolicy;
  readonly user: ProviderToolPrincipalPolicy;
  /** Optional execution route id used by persisted route-specific feature denies. */
  readonly route?: string;
}
export interface ProviderToolPolicyDescriptor {
  readonly id: ProviderToolId;
  readonly provider: ProviderToolProvider;
  readonly kind: ProviderToolKind;
  readonly category: ProviderToolCategory;
  readonly risk: ProviderToolRisk;
  readonly requiresApproval: boolean;
  readonly sandbox: readonly string[];
}
export interface ProviderToolExposureDecision {
  readonly tools: readonly ProviderToolPolicyDescriptor[];
}
export interface ProviderToolResourceLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxProcesses: number;
}
export interface ProviderToolSandboxPolicy {
  /** Trusted absolute root. The service canonicalizes it when the policy is constructed. */
  readonly workspaceRoot: string;
  readonly isolatedCompute: boolean;
  readonly isolatedDesktop: boolean;
  readonly network: "none" | "restricted";
  /** Environment values are never accepted here; names are deny-by-default. */
  readonly environment: "none" | "allowlisted_names";
  readonly allowedEnvironmentNames: readonly string[];
  readonly limits: ProviderToolResourceLimits;
}
export interface ProviderToolTrustedAuthority {
  readonly workspace: boolean;
  readonly isolatedCompute: boolean;
  readonly isolatedDesktop: boolean;
  readonly principalStorage: boolean;
}
/** Immutable server-owned policy. It must never be populated from request data. */
export interface ProviderToolPolicyConfig {
  readonly sandbox?: ProviderToolSandboxPolicy;
  readonly principalStorage?: boolean;
}
export interface ProviderToolPathRequest {
  readonly path: string;
  readonly access: "read" | "write";
  readonly target: "file" | "directory" | "new-or-file";
}
/** Untrusted, structurally validated execution requests. Provider payloads remain outside this service. */
export interface ProviderToolExecutionOptions {
  readonly paths?: readonly ProviderToolPathRequest[];
  readonly networkRequested?: boolean;
  readonly environmentNames?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxMemoryBytes?: number;
  readonly maxProcesses?: number;
}
/** Server-authoritative input rechecked immediately before runtime execution. */
export interface ProviderToolExecutionRevalidationInput {
  readonly policy: ProviderToolPolicyContext;
  readonly toolId: string;
  readonly provider: ProviderToolProvider;
  readonly kind: string;
  readonly options: ProviderToolExecutionOptions;
  readonly approval: ProviderToolApprovalState;
}
export interface ProviderToolExecutionDecision {
  readonly tool: ProviderToolPolicyDescriptor;
  readonly workspaceRoot: string | null;
}

export class ProviderToolUnsupported extends Data.TaggedError("ProviderToolUnsupported")<{
  readonly toolId: string;
  readonly provider: string;
  readonly model: string;
  readonly reason: "unknown_tool" | "unknown_model" | "model_unsupported";
}> {}
export class ProviderToolCapabilityDenied extends Data.TaggedError("ProviderToolCapabilityDenied")<{
  readonly toolId: string;
  readonly provider: ProviderToolProvider;
  readonly model: string;
  readonly reason: "account_unsupported";
}> {}
export class ProviderToolPolicyDenied extends Data.TaggedError("ProviderToolPolicyDenied")<{
  readonly toolId: string;
  readonly reason:
    | "app_disabled"
    | "user_disabled"
    | "category_denied"
    | "network_denied"
    | "provider_files_denied"
    | "high_risk_disabled"
    | "feature_flag_disabled";
}> {}
export class ProviderToolApprovalRequired extends Data.TaggedError("ProviderToolApprovalRequired")<{
  readonly toolId: string;
}> {}
export class ProviderToolApprovalDenied extends Data.TaggedError("ProviderToolApprovalDenied")<{
  readonly toolId: string;
}> {}
export class ProviderToolApprovalCancelled extends Data.TaggedError(
  "ProviderToolApprovalCancelled",
)<{ readonly toolId: string }> {}
export class ProviderToolSandboxViolation extends Data.TaggedError("ProviderToolSandboxViolation")<{
  readonly toolId: string;
  readonly reason: string;
}> {}
export class ProviderToolPathViolation extends Data.TaggedError("ProviderToolPathViolation")<{
  readonly toolId: string;
  readonly path: string;
  readonly reason: string;
}> {}
export class ProviderToolOptionsViolation extends Data.TaggedError("ProviderToolOptionsViolation")<{
  readonly toolId: string;
  readonly reason: string;
}> {}
export type ProviderToolPolicyFailure =
  | ProviderToolUnsupported
  | ProviderToolCapabilityDenied
  | ProviderToolPolicyDenied
  | ProviderToolApprovalRequired
  | ProviderToolApprovalDenied
  | ProviderToolApprovalCancelled
  | ProviderToolSandboxViolation
  | ProviderToolPathViolation
  | ProviderToolOptionsViolation
  | UnknownModelFeatureCapability
  | ModelFeatureFlagStoreFailed;

const highRisk = new Set<ProviderToolCategory>([
  "execution.shell",
  "computer.control",
  "filesystem.write",
  "memory.read_write",
  "integration.mcp.remote",
]);
const readOnly = new Set<ProviderToolCategory>([
  "network.search",
  "network.fetch",
  "data.provider_files.read",
]);
export function classifyProviderToolRisk(tool: AnyProviderToolDescriptor): ProviderToolRisk {
  if (highRisk.has(tool.category) || tool.sideEffect === "write") return "high";
  return readOnly.has(tool.category) && tool.sideEffect !== "stateful_execution"
    ? "read_only"
    : "elevated";
}
const has = <A>(values: readonly A[] | undefined, value: A) => values?.includes(value) ?? false;
const publicDescriptor = (tool: AnyProviderToolDescriptor): ProviderToolPolicyDescriptor => {
  const risk = classifyProviderToolRisk(tool);
  return Object.freeze({
    id: tool.id,
    provider: tool.provider,
    kind: tool.kind,
    category: tool.category,
    risk,
    requiresApproval: risk === "high" || tool.approval === "provider_interrupt",
    sandbox: Object.freeze([...tool.sandbox]),
  });
};
function denial(
  tool: AnyProviderToolDescriptor,
  app: ProviderToolPrincipalPolicy,
  user: ProviderToolPrincipalPolicy,
): ProviderToolPolicyDenied | null {
  if (
    has(app.disabledToolIds, tool.id) ||
    (app.enabledToolIds && !has(app.enabledToolIds, tool.id))
  )
    return new ProviderToolPolicyDenied({ toolId: tool.id, reason: "app_disabled" });
  if (
    has(user.disabledToolIds, tool.id) ||
    (user.enabledToolIds && !has(user.enabledToolIds, tool.id))
  )
    return new ProviderToolPolicyDenied({ toolId: tool.id, reason: "user_disabled" });
  if (
    (app.allowedCategories && !has(app.allowedCategories, tool.category)) ||
    (user.allowedCategories && !has(user.allowedCategories, tool.category))
  )
    return new ProviderToolPolicyDenied({ toolId: tool.id, reason: "category_denied" });
  if (
    tool.dataAccess.includes("public_network") &&
    (app.allowNetwork === false || user.allowNetwork === false)
  )
    return new ProviderToolPolicyDenied({ toolId: tool.id, reason: "network_denied" });
  if (
    tool.dataAccess.includes("provider_files") &&
    (app.allowProviderFiles !== true || user.allowProviderFiles !== true)
  )
    return new ProviderToolPolicyDenied({ toolId: tool.id, reason: "provider_files_denied" });
  if (
    classifyProviderToolRisk(tool) === "high" &&
    (app.allowHighRisk !== true || user.allowHighRisk !== true)
  )
    return new ProviderToolPolicyDenied({ toolId: tool.id, reason: "high_risk_disabled" });
  return null;
}
const noTrustedAuthority: ProviderToolTrustedAuthority = Object.freeze({
  workspace: false,
  isolatedCompute: false,
  isolatedDesktop: false,
  principalStorage: false,
});
export function hasRequiredProviderToolAuthority(
  tool: AnyProviderToolDescriptor,
  authority: ProviderToolTrustedAuthority = noTrustedAuthority,
): boolean {
  return tool.sandbox.every((requirement) => {
    switch (requirement) {
      case "workspace_required":
        return authority.workspace;
      case "isolated_compute_required":
        return authority.isolatedCompute;
      case "isolated_desktop_required":
        return authority.isolatedDesktop;
      case "principal_storage_required":
        return authority.principalStorage;
      default:
        return true;
    }
  });
}
export function decideProviderToolExposure(
  tools: readonly AnyProviderToolDescriptor[],
  context: ProviderToolPolicyContext,
  authority: ProviderToolTrustedAuthority = noTrustedAuthority,
): ProviderToolExposureDecision {
  return Object.freeze({
    tools: Object.freeze(
      tools
        .filter(
          (tool) =>
            denial(tool, context.app, context.user) === null &&
            hasRequiredProviderToolAuthority(tool, authority),
        )
        .map(publicDescriptor)
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

type ValidationFailure =
  | ProviderToolSandboxViolation
  | ProviderToolOptionsViolation
  | ProviderToolPathViolation;
const executionOptionKeys = new Set([
  "paths",
  "networkRequested",
  "environmentNames",
  "timeoutMs",
  "maxOutputBytes",
  "maxMemoryBytes",
  "maxProcesses",
]);
const pathRequestKeys = new Set(["path", "access", "target"]);
function validateSandbox(
  tool: AnyProviderToolDescriptor,
  options: ProviderToolExecutionOptions,
  sandbox: ProviderToolSandboxPolicy | undefined,
): Result.Result<string | null, ValidationFailure> {
  if (Object.keys(options).some((key) => !executionOptionKeys.has(key)))
    return Result.fail(
      new ProviderToolOptionsViolation({ toolId: tool.id, reason: "unknown_policy_option" }),
    );
  const appManaged = tool.sandbox.some(
    (requirement) =>
      requirement === "workspace_required" ||
      requirement === "isolated_compute_required" ||
      requirement === "isolated_desktop_required" ||
      requirement === "principal_storage_required",
  );
  if (appManaged && sandbox === undefined)
    return Result.fail(
      new ProviderToolSandboxViolation({ toolId: tool.id, reason: "trusted_profile_required" }),
    );
  const root = sandbox?.workspaceRoot;
  if (tool.sandbox.includes("isolated_compute_required") && sandbox?.isolatedCompute !== true)
    return Result.fail(
      new ProviderToolSandboxViolation({ toolId: tool.id, reason: "isolated_compute_required" }),
    );
  if (tool.sandbox.includes("isolated_desktop_required") && sandbox?.isolatedDesktop !== true)
    return Result.fail(
      new ProviderToolSandboxViolation({ toolId: tool.id, reason: "isolated_desktop_required" }),
    );
  if (
    options.networkRequested &&
    tool.sandbox.includes("provider_hosted") === false &&
    sandbox?.network !== "restricted"
  )
    return Result.fail(
      new ProviderToolSandboxViolation({ toolId: tool.id, reason: "network_denied" }),
    );
  const environment = options.environmentNames ?? [];
  if (
    environment.length > 0 &&
    (sandbox?.environment !== "allowlisted_names" ||
      environment.some((name) => !sandbox.allowedEnvironmentNames.includes(name)))
  )
    return Result.fail(
      new ProviderToolSandboxViolation({ toolId: tool.id, reason: "environment_denied" }),
    );
  const limits = sandbox?.limits;
  const requests = [
    ["timeout", options.timeoutMs, limits?.timeoutMs],
    ["output", options.maxOutputBytes, limits?.maxOutputBytes],
    ["memory", options.maxMemoryBytes, limits?.maxMemoryBytes],
    ["processes", options.maxProcesses, limits?.maxProcesses],
  ] as const;
  for (const [name, value, maximum] of requests)
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || maximum === undefined || value > maximum)
    )
      return Result.fail(
        new ProviderToolOptionsViolation({ toolId: tool.id, reason: `${name}_limit_invalid` }),
      );
  if ((options.paths?.length ?? 0) > 0 && !appManaged)
    return Result.fail(
      new ProviderToolSandboxViolation({ toolId: tool.id, reason: "local_access_not_applicable" }),
    );
  for (const request of options.paths ?? []) {
    if (Object.keys(request).some((key) => !pathRequestKeys.has(key)))
      return Result.fail(
        new ProviderToolOptionsViolation({ toolId: tool.id, reason: "path_request_invalid" }),
      );
    if (root === undefined)
      return Result.fail(
        new ProviderToolSandboxViolation({ toolId: tool.id, reason: "trusted_profile_required" }),
      );
    if (isAbsolute(request.path))
      return Result.fail(
        new ProviderToolPathViolation({
          toolId: tool.id,
          path: request.path,
          reason: "absolute_path",
        }),
      );
    if (isCredentialPath(request.path))
      return Result.fail(
        new ProviderToolPathViolation({
          toolId: tool.id,
          path: request.path,
          reason: "credential_path",
        }),
      );
    const violation = Result.match(resolveProjectPath(root, request.path, request.target), {
      onFailure: (rejection) =>
        new ProviderToolPathViolation({
          toolId: tool.id,
          path: request.path,
          reason: rejection.reason,
        }),
      onSuccess: () => null,
    });
    if (violation) return Result.fail(violation);
  }
  return Result.succeed(appManaged ? (root ?? null) : null);
}

export interface ProviderToolPolicyApi {
  readonly expose: (
    context: ProviderToolPolicyContext,
  ) => Effect.Effect<ProviderToolExposureDecision, ProviderToolPolicyFailure>;
  readonly revalidateExecution: (
    input: ProviderToolExecutionRevalidationInput,
  ) => Effect.Effect<ProviderToolExecutionDecision, ProviderToolPolicyFailure>;
}
const trustedSandbox = (
  config: ProviderToolPolicyConfig,
): ProviderToolSandboxPolicy | undefined => {
  const sandbox = config.sandbox;
  if (sandbox === undefined) return undefined;
  return Object.freeze({
    ...sandbox,
    workspaceRoot: canonicalPath(resolve(sandbox.workspaceRoot)),
    allowedEnvironmentNames: Object.freeze([...sandbox.allowedEnvironmentNames]),
    limits: Object.freeze({ ...sandbox.limits }),
  });
};
export function makeProviderToolPolicy(
  registry: ProviderToolCapabilityRegistry["Service"],
  config: ProviderToolPolicyConfig = {},
  featureFlags?: ModelFeatureFlagsApi,
): ProviderToolPolicyApi {
  const sandbox = trustedSandbox(config);
  const authority: ProviderToolTrustedAuthority = Object.freeze({
    workspace: sandbox !== undefined,
    isolatedCompute: sandbox?.isolatedCompute === true,
    isolatedDesktop: sandbox?.isolatedDesktop === true,
    principalStorage: config.principalStorage === true,
  });
  const unsupported = (
    toolId: string,
    context: ProviderToolPolicyContext,
    reason: ProviderToolUnsupported["reason"],
  ) =>
    new ProviderToolUnsupported({
      toolId,
      provider: context.provider,
      model: context.model,
      reason,
    });
  const resolveAccount = (context: ProviderToolPolicyContext) =>
    registry
      .resolve({
        provider: context.provider,
        model: context.model,
        accountToolKinds: context.accountToolKinds,
      })
      .pipe(Effect.mapError(() => unsupported("*", context, "unknown_model")));
  const applyFeatureFlags = (
    tools: readonly AnyProviderToolDescriptor[],
    context: ProviderToolPolicyContext,
  ) =>
    featureFlags === undefined
      ? Effect.succeed(tools)
      : Effect.filter(tools, (tool) =>
          Effect.map(
            featureFlags.decide({
              provider: context.provider,
              model: context.model,
              capability: tool.id,
              route: context.route,
            }),
            (decision) => decision.allowed,
          ),
        );
  const assertFeatureFlag = (
    tool: AnyProviderToolDescriptor,
    context: ProviderToolPolicyContext,
  ) =>
    featureFlags === undefined
      ? Effect.void
      : Effect.flatMap(
          featureFlags.decide({
            provider: context.provider,
            model: context.model,
            capability: tool.id,
            route: context.route,
          }),
          (decision) =>
            decision.allowed
              ? Effect.void
              : Effect.fail(
                  new ProviderToolPolicyDenied({
                    toolId: tool.id,
                    reason: "feature_flag_disabled",
                  }),
                ),
        );
  return {
    expose: (context) =>
      Effect.map(
        Effect.flatMap(resolveAccount(context), (tools) => applyFeatureFlags(tools, context)),
        (tools) => decideProviderToolExposure(tools, context, authority),
      ),
    revalidateExecution: (input) =>
      Effect.gen(function* () {
        const tool = yield* registry
          .get(input.toolId)
          .pipe(Effect.mapError(() => unsupported(input.toolId, input.policy, "unknown_tool")));
        if (
          tool.provider !== input.provider ||
          input.policy.provider !== input.provider ||
          tool.kind !== input.kind
        )
          return yield* Effect.fail(
            new ProviderToolOptionsViolation({
              toolId: input.toolId,
              reason: "tool_identity_mismatch",
            }),
          );
        yield* assertFeatureFlag(tool, input.policy);
        const modelTools = yield* registry
          .resolve({ provider: input.provider, model: input.policy.model })
          .pipe(Effect.mapError(() => unsupported(input.toolId, input.policy, "unknown_model")));
        if (!modelTools.some((entry) => entry.id === tool.id))
          return yield* Effect.fail(unsupported(input.toolId, input.policy, "model_unsupported"));
        const accountTools = yield* resolveAccount(input.policy);
        if (!accountTools.some((entry) => entry.id === tool.id))
          return yield* Effect.fail(
            new ProviderToolCapabilityDenied({
              toolId: input.toolId,
              provider: input.policy.provider,
              model: input.policy.model,
              reason: "account_unsupported",
            }),
          );
        const refused = denial(tool, input.policy.app, input.policy.user);
        if (refused) return yield* Effect.fail(refused);
        const exposed = publicDescriptor(tool);
        if (exposed.requiresApproval) {
          if (input.approval === "not_requested")
            return yield* Effect.fail(new ProviderToolApprovalRequired({ toolId: input.toolId }));
          if (input.approval === "denied")
            return yield* Effect.fail(new ProviderToolApprovalDenied({ toolId: input.toolId }));
          if (input.approval === "cancelled")
            return yield* Effect.fail(new ProviderToolApprovalCancelled({ toolId: input.toolId }));
        }
        const workspaceRoot = yield* Result.match(validateSandbox(tool, input.options, sandbox), {
          onFailure: Effect.fail,
          onSuccess: Effect.succeed,
        });
        return Object.freeze({ tool: exposed, workspaceRoot });
      }),
  };
}
export class ProviderToolPolicy extends Context.Service<
  ProviderToolPolicy,
  ProviderToolPolicyApi
>()("memory-agent/ProviderToolPolicy") {
  /** Production default: provider-hosted tools only; no local authority is granted. */
  static readonly layer = Layer.effect(
    ProviderToolPolicy,
    Effect.map(ProviderToolCapabilityRegistry, (registry) => makeProviderToolPolicy(registry)),
  );
  /** Production flag-aware policy. Both model exposure and execution revalidation read fresh flags. */
  static readonly featureFlagLayer = Layer.effect(
    ProviderToolPolicy,
    Effect.gen(function* () {
      return makeProviderToolPolicy(
        yield* ProviderToolCapabilityRegistry,
        {},
        yield* ModelFeatureFlags,
      );
    }),
  );
  static readonly featureFlagLayerWithConfig = (config: ProviderToolPolicyConfig) =>
    Layer.effect(
      ProviderToolPolicy,
      Effect.gen(function* () {
        return makeProviderToolPolicy(
          yield* ProviderToolCapabilityRegistry,
          config,
          yield* ModelFeatureFlags,
        );
      }),
    );
  /** Construct a policy Layer from trusted server configuration. */
  static readonly layerWithConfig = (config: ProviderToolPolicyConfig) =>
    Layer.effect(
      ProviderToolPolicy,
      Effect.map(ProviderToolCapabilityRegistry, (registry) =>
        makeProviderToolPolicy(registry, config),
      ),
    );
  static readonly layerFrom = (service: ProviderToolPolicyApi) =>
    Layer.succeed(ProviderToolPolicy, service);
}

type InstalledDescriptor = (typeof providerToolDescriptors)[number];
type DescriptorFor<Id extends ProviderToolId> = Extract<InstalledDescriptor, { readonly id: Id }>;
type FactoryFor<Id extends ProviderToolId> = DescriptorFor<Id>["extension"]["factory"];
type FactoryRequestFor<Descriptor extends InstalledDescriptor> =
  Descriptor extends InstalledDescriptor
    ? Readonly<{
        id: Descriptor["id"];
        args: Readonly<Parameters<Descriptor["extension"]["factory"]>>;
      }>
    : never;

/** Exact provider factory arguments correlated with each provider-qualified tool id. */
export type ProviderToolFactoryRequest = FactoryRequestFor<InstalledDescriptor>;
export interface ComposedProviderTool<Id extends ProviderToolId = ProviderToolId> {
  readonly id: Id;
  readonly descriptor: DescriptorFor<Id>;
  readonly tool: Awaited<ReturnType<FactoryFor<Id>>>;
}
export class ProviderToolNotExposed extends Data.TaggedError("ProviderToolNotExposed")<{
  readonly toolId: string;
  readonly provider: ProviderToolProvider;
  readonly model: string;
}> {}
export class ProviderToolFactoryFailure extends Data.TaggedError("ProviderToolFactoryFailure")<{
  readonly toolId: ProviderToolId;
  readonly cause: unknown;
}> {}
export class ProviderToolFactoryOptionsFailure extends Data.TaggedError(
  "ProviderToolFactoryOptionsFailure",
)<{
  readonly toolId: string;
  readonly reason: "invalid_request" | "provider_mismatch";
}> {}
export class ProviderToolOperationFailure extends Data.TaggedError("ProviderToolOperationFailure")<{
  readonly toolId: ProviderToolId;
  readonly cause: unknown;
}> {}
export class ProviderToolLeaseFailure extends Data.TaggedError("ProviderToolLeaseFailure")<{
  readonly toolId: ProviderToolId;
  readonly phase: "acquire" | "release";
  readonly cause: unknown;
}> {}
export class ProviderToolLifecycleFailure extends Data.TaggedError("ProviderToolLifecycleFailure")<{
  readonly toolId: ProviderToolId;
  readonly cause: unknown;
}> {}
export class ProviderToolNormalizationFailure extends Data.TaggedError(
  "ProviderToolNormalizationFailure",
)<{
  readonly toolId: ProviderToolId;
  readonly cause: unknown;
}> {}
export class ProviderToolPolicyPropagationFailure extends Data.TaggedError(
  "ProviderToolPolicyPropagationFailure",
)<{
  readonly toolId?: ProviderToolId;
  readonly cause: ProviderToolPolicyFailure;
}> {}
export type ProviderToolLifecycleStatus =
  | "pending"
  | "approval-required"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface ProviderToolUsageAttribution {
  readonly provider: ProviderToolProvider;
  readonly model: string;
  readonly accountId: string;
  readonly toolId: ProviderToolId;
  readonly runId: string;
}
export interface ProviderToolUsage {
  readonly attribution?: ProviderToolUsageAttribution;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly serverToolRequests?: Readonly<Record<string, number>>;
  readonly raw: unknown;
}
export interface ProviderToolCost {
  readonly amount: number;
  readonly currency?: string;
  readonly raw: unknown;
}
export interface ProviderToolActionMetadata {
  readonly mode: "future_executor";
  readonly provider: ProviderToolProvider;
  readonly toolId: ProviderToolId;
  readonly kind: ProviderToolKind;
  readonly workspaceRoot: string | null;
}
export interface ProviderToolResultEnvelope<Raw = unknown> {
  readonly provider: ProviderToolProvider;
  readonly toolId: ProviderToolId;
  readonly model: string;
  /** Stable attribution only. This API deliberately has no credential/log metadata field. */
  readonly accountId: string;
  readonly runId: string;
  readonly execution: ProviderToolExecution;
  readonly status: ProviderToolLifecycleStatus;
  /** Provider-native event/result discriminator when one was reported. */
  readonly providerKind?: string;
  /** True when a provider discriminator is present but has no common-state mapping. */
  readonly unknownKind: boolean;
  /** Present instead of execution for caller-loop tools. */
  readonly action?: ProviderToolActionMetadata;
  readonly usage?: ProviderToolUsage;
  readonly cost?: ProviderToolCost;
  /** Exact payload reference, including all unknown provider variants. */
  readonly raw: Raw;
}
export interface ProviderToolOperationResult<Raw = unknown> {
  readonly raw: Raw;
  /** Optional provider-native event/result discriminator. Unknown values are retained. */
  readonly kind?: string;
  readonly usage?: unknown;
  readonly cost?: unknown;
}
export interface ProviderToolLease {
  readonly release: () => void | Promise<void>;
}
export interface ProviderToolOperationContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string | null;
  readonly progress: <Raw>(event: ProviderToolOperationResult<Raw>) => void;
}
export interface ProviderToolExecutionRequest<Raw = unknown> {
  readonly policy: ProviderToolPolicyContext;
  readonly toolId: ProviderToolId;
  readonly kind: string;
  readonly accountId: string;
  readonly runId: string;
  readonly options: ProviderToolExecutionOptions;
  readonly approval: ProviderToolApprovalState;
  /** Invoked only for provider-hosted or hybrid tools; caller-loop tools return action metadata. */
  readonly operation?: (
    context: ProviderToolOperationContext,
  ) => ProviderToolOperationResult<Raw> | Promise<ProviderToolOperationResult<Raw>>;
  readonly acquire?: (signal: AbortSignal) => ProviderToolLease | Promise<ProviderToolLease>;
  readonly onLifecycle?: (event: ProviderToolResultEnvelope) => void | Promise<void>;
}
export type ProviderToolRuntimeFailure =
  | ProviderToolPolicyFailure
  | ProviderToolNotExposed
  | ProviderToolFactoryFailure
  | ProviderToolFactoryOptionsFailure
  | ProviderToolOperationFailure
  | ProviderToolLeaseFailure
  | ProviderToolLifecycleFailure
  | ProviderToolNormalizationFailure
  | ProviderToolPolicyPropagationFailure;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Provider SDK payloads are intentionally opaque; normalization reads optional reported counters while retaining the exact raw value. */
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  // SAFETY: the non-null object check establishes string-key property access; every read remains unknown.
  return value as Readonly<Record<string, unknown>>;
};
const firstNumber = (source: Readonly<Record<string, unknown>>, keys: readonly string[]) => {
  for (const key of keys) {
    const found = finite(source[key]);
    if (found !== undefined) return found;
  }
  return undefined;
};
const numberRecord = (value: unknown): Readonly<Record<string, number>> | undefined => {
  const source = objectRecord(value);
  if (source === undefined) return undefined;
  const entries = Object.entries(source).filter(
    (entry): entry is [string, number] => finite(entry[1]) !== undefined,
  );
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
};
/** Normalize reported values only; never estimate absent tokens or cost. */
export function normalizeProviderToolUsage(
  raw: unknown,
  attribution?: ProviderToolUsageAttribution,
): ProviderToolUsage | undefined {
  const source = objectRecord(raw);
  if (source === undefined) return undefined;
  return Object.freeze({
    attribution: attribution === undefined ? undefined : Object.freeze({ ...attribution }),
    inputTokens: firstNumber(source, ["inputTokens", "input_tokens", "promptTokens"]),
    outputTokens: firstNumber(source, ["outputTokens", "output_tokens", "completionTokens"]),
    totalTokens: firstNumber(source, ["totalTokens", "total_tokens"]),
    cacheReadTokens: firstNumber(source, [
      "cacheReadTokens",
      "cache_read_input_tokens",
      "cachedTokens",
    ]),
    cacheWriteTokens: firstNumber(source, ["cacheWriteTokens", "cache_creation_input_tokens"]),
    serverToolRequests:
      numberRecord(source.serverToolRequests) ??
      numberRecord(source.server_tool_requests) ??
      numberRecord(source.server_tool_use),
    raw,
  });
}
export function normalizeProviderToolCost(raw: unknown): ProviderToolCost | undefined {
  const source = objectRecord(raw);
  if (source === undefined) return undefined;
  const amount = finite(source.amount) ?? finite(source.cost);
  return amount === undefined
    ? undefined
    : Object.freeze({
        amount,
        currency: typeof source.currency === "string" ? source.currency : undefined,
        raw,
      });
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
const providerStatus = new Map<string, ProviderToolLifecycleStatus>([
  ["pending", "pending"],
  ["queued", "pending"],
  ["approval_required", "approval-required"],
  ["approval_pending", "approval-required"],
  ["started", "running"],
  ["running", "running"],
  ["progress", "running"],
  ["in_progress", "running"],
  ["succeeded", "succeeded"],
  ["success", "succeeded"],
  ["completed", "succeeded"],
  ["failed", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
]);
export function normalizeProviderToolLifecycleStatus(
  kind: string | undefined,
  fallback: ProviderToolLifecycleStatus,
): ProviderToolLifecycleStatus {
  if (kind === undefined) return fallback;
  return providerStatus.get(kind) ?? fallback;
}
const runtimeEnvelope = <Raw>(
  request: ProviderToolExecutionRequest,
  descriptor: AnyProviderToolDescriptor,
  fallback: ProviderToolLifecycleStatus,
  result: ProviderToolOperationResult<Raw>,
): ProviderToolResultEnvelope<Raw> => {
  const status = normalizeProviderToolLifecycleStatus(result.kind, fallback);
  return Object.freeze({
    provider: descriptor.provider,
    toolId: descriptor.id,
    model: request.policy.model,
    accountId: request.accountId,
    runId: request.runId,
    execution: descriptor.execution,
    status,
    providerKind: result.kind,
    unknownKind: result.kind !== undefined && !providerStatus.has(result.kind),
    usage: normalizeProviderToolUsage(result.usage, {
      provider: descriptor.provider,
      model: request.policy.model,
      accountId: request.accountId,
      toolId: descriptor.id,
      runId: request.runId,
    }),
    cost: normalizeProviderToolCost(result.cost),
    raw: result.raw,
  });
};
export interface ProviderToolRuntimeApi {
  readonly compose: (
    policy: ProviderToolPolicyContext,
    requests?: readonly ProviderToolFactoryRequest[],
  ) => Effect.Effect<
    readonly ComposedProviderTool[],
    | ProviderToolPolicyFailure
    | ProviderToolNotExposed
    | ProviderToolFactoryFailure
    | ProviderToolFactoryOptionsFailure
  >;
  readonly execute: <Raw>(
    request: ProviderToolExecutionRequest<Raw>,
  ) => Effect.Effect<ProviderToolResultEnvelope<Raw | undefined>, ProviderToolRuntimeFailure>;
}
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This is the runtime parsing boundary for opaque provider factory option envelopes. */
type ProviderFactoryValidator = (args: readonly unknown[]) => boolean;
const plainObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  objectRecord(value);
const hasOnlyKeys = (value: unknown, allowed: readonly string[]): boolean => {
  const record = plainObject(value);
  return record !== undefined && Object.keys(record).every((key) => allowed.includes(key));
};
const optionalConfig =
  (allowed: readonly string[], discriminator?: string): ProviderFactoryValidator =>
  (args) =>
    args.length <= 1 &&
    (args.length === 0 ||
      (hasOnlyKeys(args[0], allowed) &&
        (discriminator === undefined || plainObject(args[0])?.type === discriminator)));
const requiredConfig =
  (
    allowed: readonly string[],
    discriminator?: string | ((value: unknown) => boolean),
  ): ProviderFactoryValidator =>
  (args) => {
    if (args.length !== 1 || !hasOnlyKeys(args[0], allowed)) return false;
    if (discriminator === undefined) return true;
    const type = plainObject(args[0])?.type;
    return typeof discriminator === "string" ? type === discriminator : discriminator(type);
  };
const versioned = (prefix: string) => (value: unknown) =>
  typeof value === "string" && value.startsWith(`${prefix}_`);
const noArgs: ProviderFactoryValidator = (args) => args.length === 0;
const openAIWebKeys = [
  "type",
  "external_web_access",
  "filters",
  "search_context_size",
  "user_location",
];
const providerFactoryValidators = {
  "openai:web_search": requiredConfig(openAIWebKeys, "web_search"),
  "openai:web_search_preview": requiredConfig(
    ["type", "search_context_size", "user_location"],
    "web_search_preview",
  ),
  "openai:file_search": requiredConfig(
    ["type", "vector_store_ids", "filters", "max_num_results", "ranking_options"],
    "file_search",
  ),
  "openai:image_generation": requiredConfig([
    "action",
    "background",
    "input_fidelity",
    "input_image_mask",
    "model",
    "moderation",
    "output_compression",
    "output_format",
    "partial_images",
    "quality",
    "size",
  ]),
  "openai:code_interpreter": requiredConfig(["type", "container"], "code_interpreter"),
  "openai:mcp": requiredConfig(
    [
      "type",
      "server_label",
      "server_url",
      "connector_id",
      "authorization",
      "headers",
      "allowed_tools",
      "require_approval",
      "server_description",
    ],
    "mcp",
  ),
  "openai:computer_use": requiredConfig(
    ["type", "display_width", "display_height", "environment"],
    "computer_use_preview",
  ),
  "openai:local_shell": noArgs,
  "openai:shell": optionalConfig(["type", "environment"], "shell"),
  "openai:apply_patch": noArgs,
  "openai:custom": requiredConfig(
    ["type", "name", "allowed_callers", "defer_loading", "description", "format"],
    "custom",
  ),
  "anthropic:web_search": requiredConfig(
    ["type", "name", "max_uses", "allowed_domains", "blocked_domains", "user_location"],
    versioned("web_search"),
  ),
  "anthropic:web_fetch": optionalConfig(
    [
      "type",
      "name",
      "max_uses",
      "allowed_domains",
      "blocked_domains",
      "citations",
      "max_content_tokens",
    ],
    "web_fetch_20250910",
  ),
  "anthropic:code_execution": (args) =>
    args.length >= 1 &&
    args.length <= 2 &&
    hasOnlyKeys(args[0], ["type", "name"]) &&
    versioned("code_execution")(plainObject(args[0])?.type) &&
    (args.length === 1 || hasOnlyKeys(args[1], ["skills"])),
  "anthropic:computer_use": requiredConfig(
    ["type", "name", "display_width_px", "display_height_px", "display_number", "enable_zoom"],
    versioned("computer"),
  ),
  "anthropic:bash": requiredConfig(["type", "name"], versioned("bash")),
  "anthropic:text_editor": requiredConfig(
    ["type", "name", "max_characters"],
    versioned("text_editor"),
  ),
  "anthropic:memory": optionalConfig(["type", "name"], "memory_20250818"),
} satisfies Record<ProviderToolId, ProviderFactoryValidator>;
/** Kept public for inventory completeness tests; validators themselves remain an implementation detail. */
// SAFETY: `satisfies Record<ProviderToolId, ...>` above proves every own key is a ProviderToolId.
export const providerToolFactoryValidatorIds = Object.freeze(
  Object.keys(providerFactoryValidators).toSorted() as readonly ProviderToolId[],
);
const validateProviderFactoryArgs = (id: ProviderToolId, args: readonly unknown[]) =>
  providerFactoryValidators[id](args);
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

/* oxlint-disable anti-slop/no-unknown-parameters -- This private erased bridge dispatches requests already checked by the public discriminated factory union. */
const invokeProviderFactory = (
  descriptor: AnyProviderToolDescriptor,
  args: readonly unknown[],
): object | Promise<object> => {
  // SAFETY: compose correlates descriptor and args by the public ProviderToolFactoryRequest id union.
  const factory = descriptor.extension.factory as (
    ...values: readonly unknown[]
  ) => object | Promise<object>;
  return factory(...args);
};
/* oxlint-enable anti-slop/no-unknown-parameters */
export function makeProviderToolRuntime(
  registry: ProviderToolCapabilityRegistry["Service"],
  policyService: ProviderToolPolicy["Service"],
): ProviderToolRuntimeApi {
  return {
    compose: (context, requests = []) =>
      Effect.gen(function* () {
        const exposed = yield* policyService.expose(context);
        const allowed = new Set(exposed.tools.map((tool) => tool.id));
        const output: ComposedProviderTool[] = [];
        for (const request of [...requests].toSorted((a, b) => a.id.localeCompare(b.id))) {
          const requestKeys = Object.keys(request);
          if (
            requestKeys.some((key) => key !== "id" && key !== "args") ||
            !Array.isArray(request.args)
          )
            return yield* new ProviderToolFactoryOptionsFailure({
              toolId: String(request.id),
              reason: "invalid_request",
            });
          if (!request.id.startsWith(`${context.provider}:`))
            return yield* new ProviderToolFactoryOptionsFailure({
              toolId: request.id,
              reason: "provider_mismatch",
            });
          if (!validateProviderFactoryArgs(request.id, request.args))
            return yield* new ProviderToolOptionsViolation({
              toolId: request.id,
              reason: "invalid_factory_options",
            });
          if (!allowed.has(request.id))
            return yield* new ProviderToolNotExposed({
              toolId: request.id,
              provider: context.provider,
              model: context.model,
            });
          const descriptor = yield* registry.get(request.id).pipe(
            Effect.mapError(
              () =>
                new ProviderToolNotExposed({
                  toolId: request.id,
                  provider: context.provider,
                  model: context.model,
                }),
            ),
          );
          const tool = yield* Effect.tryPromise({
            try: () => Promise.resolve(invokeProviderFactory(descriptor, request.args)),
            catch: (cause) => new ProviderToolFactoryFailure({ toolId: request.id, cause }),
          });
          // SAFETY: registry.get returned the same provider-qualified id carried by the request.
          output.push({ id: request.id, descriptor, tool } as ComposedProviderTool);
        }
        return Object.freeze(output);
      }),
    execute: (request) =>
      Effect.gen(function* () {
        const descriptor = yield* registry.get(request.toolId).pipe(
          Effect.mapError(
            () =>
              new ProviderToolNotExposed({
                toolId: request.toolId,
                provider: request.policy.provider,
                model: request.policy.model,
              }),
          ),
        );
        const decision = yield* policyService.revalidateExecution({
          policy: request.policy,
          toolId: request.toolId,
          provider: request.policy.provider,
          kind: request.kind,
          options: request.options,
          approval: request.approval,
        });
        const lifecycle = (
          status: ProviderToolLifecycleStatus,
          result: ProviderToolOperationResult,
        ) => {
          const envelope = runtimeEnvelope(request, descriptor, status, result);
          return Effect.tryPromise({
            try: () => Promise.resolve(request.onLifecycle?.(envelope)),
            catch: (cause) => new ProviderToolLifecycleFailure({ toolId: request.toolId, cause }),
          });
        };
        if (descriptor.execution === "caller_loop") {
          const pending = Object.freeze({
            ...runtimeEnvelope(request, descriptor, "pending", { raw: undefined }),
            action: Object.freeze({
              mode: "future_executor" as const,
              provider: descriptor.provider,
              toolId: descriptor.id,
              kind: descriptor.kind,
              workspaceRoot: decision.workspaceRoot,
            }),
          });
          yield* lifecycle("pending", { raw: undefined });
          return pending;
        }
        if (request.operation === undefined)
          return yield* new ProviderToolOperationFailure({
            toolId: request.toolId,
            cause: new Error("provider-hosted operation is required"),
          });
        const operation = request.operation;
        const acquire = Effect.tryPromise({
          try: (signal) =>
            request.acquire === undefined
              ? Promise.resolve<ProviderToolLease>({ release: () => undefined })
              : Promise.resolve(request.acquire(signal)),
          catch: (cause) =>
            new ProviderToolLeaseFailure({ toolId: request.toolId, phase: "acquire", cause }),
        });
        const use = Effect.gen(function* () {
          yield* lifecycle("running", { raw: undefined });
          const progress: ProviderToolOperationResult[] = [];
          const operationExit = yield* Effect.tryPromise({
            try: (signal) =>
              Promise.resolve(
                operation({
                  signal,
                  workspaceRoot: decision.workspaceRoot,
                  progress: (event) => {
                    progress.push(event);
                  },
                }),
              ),
            catch: (cause) => new ProviderToolOperationFailure({ toolId: request.toolId, cause }),
          }).pipe(Effect.exit);
          for (const event of progress) yield* lifecycle("running", event);
          if (Exit.isFailure(operationExit)) return yield* Effect.failCause(operationExit.cause);
          const completed = runtimeEnvelope(request, descriptor, "succeeded", operationExit.value);
          yield* Effect.tryPromise({
            try: () => Promise.resolve(request.onLifecycle?.(completed)),
            catch: (cause) => new ProviderToolLifecycleFailure({ toolId: request.toolId, cause }),
          });
          return completed;
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const lease = yield* restore(acquire);
            const useExit = yield* restore(use).pipe(Effect.exit);
            if (Exit.isFailure(useExit)) {
              const terminal = Cause.hasInterruptsOnly(useExit.cause) ? "cancelled" : "failed";
              yield* lifecycle(terminal, { raw: undefined });
            }
            yield* Effect.tryPromise({
              try: () => Promise.resolve(lease.release()),
              catch: (cause) =>
                new ProviderToolLeaseFailure({ toolId: request.toolId, phase: "release", cause }),
            });
            return yield* Exit.isSuccess(useExit)
              ? Effect.succeed(useExit.value)
              : Effect.failCause(useExit.cause);
          }),
        );
      }),
  };
}
export class ProviderToolRuntime extends Context.Service<
  ProviderToolRuntime,
  ProviderToolRuntimeApi
>()("memory-agent/ProviderToolRuntime") {
  static readonly layer = Layer.effect(
    ProviderToolRuntime,
    Effect.gen(function* () {
      const registry = yield* ProviderToolCapabilityRegistry;
      const policy = yield* ProviderToolPolicy;
      return makeProviderToolRuntime(registry, policy);
    }),
  );
  static readonly layerFrom = (service: ProviderToolRuntimeApi) =>
    Layer.succeed(ProviderToolRuntime, service);
}
