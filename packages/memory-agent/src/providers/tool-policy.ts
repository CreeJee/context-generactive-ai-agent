import { HashSet } from "effect";
import { Function as EffectFunction } from "effect";
import { oauthProtocolPath } from "../oauth/node-runtime.ts";
import { optionalProperty } from "../optional-property.ts";
import {
  Array as EffectArray,
  HashMap,
  Option,
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Predicate,
  Ref,
  Schema,
} from "effect";
import {
  PathRejected,
  canonicalPathEffect,
  isCredentialPath,
  resolveProjectPath,
} from "../files/paths.ts";
import {
  ModelFeatureFlags,
  ModelFeatureFlagStoreFailed,
  UnknownModelFeatureCapability,
  type ModelFeatureFlagsApi,
} from "./model-feature-flags.ts";
import { ProviderVendor } from "./contracts.ts";
import {
  ProviderToolCapabilityRegistry,
  providerToolDescriptors,
  type AnyProviderToolDescriptor,
  type ProviderToolCategory,
  type ProviderToolExecution,
  type ProviderToolSandbox,
  type ProviderToolVendor,
} from "./tool-capabilities.ts";
import { ProviderToolId, type ProviderToolKind } from "./provider-tool-id.ts";
import { ProviderToolConfig, acceptsConfig, providerTools } from "./provider-tools.ts";
import type { Tool } from "effect/ai";

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
  readonly provider: ProviderToolVendor;
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
  readonly provider: ProviderToolVendor;
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
  /** Trusted absolute root. The service canonicalizes it when it validates a tool call. */
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
  readonly provider: ProviderToolVendor;
  readonly kind: string;
  readonly options: ProviderToolExecutionOptions;
  readonly approval: ProviderToolApprovalState;
}
export interface ProviderToolExecutionDecision {
  readonly tool: ProviderToolPolicyDescriptor;
  readonly workspaceRoot: string | null;
}

export class ProviderToolUnsupported extends Schema.TaggedError<ProviderToolUnsupported>()(
  "ProviderToolUnsupported",
  {
    toolId: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    reason: Schema.Literals(["unknown_tool", "unknown_model", "model_unsupported"]),
  },
) {}
export class ProviderToolCapabilityDenied extends Schema.TaggedError<ProviderToolCapabilityDenied>()(
  "ProviderToolCapabilityDenied",
  {
    toolId: Schema.String,
    provider: ProviderVendor,
    model: Schema.String,
    reason: Schema.Literals(["account_unsupported"]),
  },
) {}
export class ProviderToolPolicyDenied extends Schema.TaggedError<ProviderToolPolicyDenied>()(
  "ProviderToolPolicyDenied",
  {
    toolId: Schema.String,
    reason: Schema.Literals([
      "app_disabled",
      "user_disabled",
      "category_denied",
      "network_denied",
      "provider_files_denied",
      "high_risk_disabled",
      "feature_flag_disabled",
    ]),
  },
) {}
export class ProviderToolApprovalRequired extends Schema.TaggedError<ProviderToolApprovalRequired>()(
  "ProviderToolApprovalRequired",
  { toolId: Schema.String },
) {}
export class ProviderToolApprovalDenied extends Schema.TaggedError<ProviderToolApprovalDenied>()(
  "ProviderToolApprovalDenied",
  { toolId: Schema.String },
) {}
export class ProviderToolApprovalCancelled extends Schema.TaggedError<ProviderToolApprovalCancelled>()(
  "ProviderToolApprovalCancelled",
  { toolId: Schema.String },
) {}
export class ProviderToolSandboxViolation extends Schema.TaggedError<ProviderToolSandboxViolation>()(
  "ProviderToolSandboxViolation",
  {
    toolId: Schema.String,
    reason: Schema.Literals([
      "trusted_profile_required",
      /** The sandbox workspace root could not be resolved; `cause` has the path error. */
      "workspace_root_unavailable",
      "isolated_compute_required",
      "isolated_desktop_required",
      "network_denied",
      "environment_denied",
      "local_access_not_applicable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export class ProviderToolPathViolation extends Schema.TaggedError<ProviderToolPathViolation>()(
  "ProviderToolPathViolation",
  {
    toolId: Schema.String,
    path: Schema.String,
    reason: Schema.Union([
      Schema.Literals([
        "absolute_path",
        "credential_path",
        /** The filesystem could not be inspected; `cause` has the platform error. */
        "inspection_failed",
      ]),
      PathRejected.fields.reason,
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export class ProviderToolOptionsViolation extends Schema.TaggedError<ProviderToolOptionsViolation>()(
  "ProviderToolOptionsViolation",
  {
    toolId: Schema.String,
    reason: Schema.Literals([
      "unknown_policy_option",
      "timeout_limit_invalid",
      "output_limit_invalid",
      "memory_limit_invalid",
      "processes_limit_invalid",
      "path_request_invalid",
      "tool_identity_mismatch",
      "invalid_factory_options",
    ]),
  },
) {}
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

const highRisk = HashSet.fromIterable<ProviderToolCategory>([
  "execution.shell",
  "computer.control",
  "filesystem.write",
  "memory.read_write",
  "integration.mcp.remote",
]);
const readOnly = HashSet.fromIterable<ProviderToolCategory>([
  "network.search",
  "network.fetch",
  "data.provider_files.read",
]);
export function classifyProviderToolRisk(tool: AnyProviderToolDescriptor): ProviderToolRisk {
  return Match.value(tool).pipe(
    Match.when(
      ({ category, sideEffect }) => HashSet.has(highRisk, category) || sideEffect === "write",
      () => "high" as const,
    ),
    Match.when(
      ({ category, sideEffect }) =>
        HashSet.has(readOnly, category) && sideEffect !== "stateful_execution",
      () => "read_only" as const,
    ),
    Match.orElse(() => "elevated" as const),
  );
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
type Principals = Pick<ProviderToolPolicyContext, "app" | "user">;
/** Disabled by name, or left out of a list of enabled tools. */
const toolExcluded = (policy: ProviderToolPrincipalPolicy, id: ProviderToolId) =>
  has(policy.disabledToolIds, id) ||
  (policy.enabledToolIds !== undefined && !has(policy.enabledToolIds, id));
const categoryExcluded = (policy: ProviderToolPrincipalPolicy, category: ProviderToolCategory) =>
  policy.allowedCategories !== undefined && !has(policy.allowedCategories, category);
/** The principals' checks in the order they are reported: the first that refuses gives the reason. */
const denialRules: ReadonlyArray<{
  readonly reason: Exclude<ProviderToolPolicyDenied["reason"], "feature_flag_disabled">;
  readonly refuses: (tool: AnyProviderToolDescriptor, principals: Principals) => boolean;
}> = [
  { reason: "app_disabled", refuses: (tool, { app }) => toolExcluded(app, tool.id) },
  { reason: "user_disabled", refuses: (tool, { user }) => toolExcluded(user, tool.id) },
  {
    reason: "category_denied",
    refuses: (tool, { app, user }) =>
      categoryExcluded(app, tool.category) || categoryExcluded(user, tool.category),
  },
  {
    reason: "network_denied",
    refuses: (tool, { app, user }) =>
      tool.dataAccess.includes("public_network") &&
      (app.allowNetwork === false || user.allowNetwork === false),
  },
  {
    reason: "provider_files_denied",
    refuses: (tool, { app, user }) =>
      tool.dataAccess.includes("provider_files") &&
      (app.allowProviderFiles !== true || user.allowProviderFiles !== true),
  },
  {
    reason: "high_risk_disabled",
    refuses: (tool, { app, user }) =>
      classifyProviderToolRisk(tool) === "high" &&
      (app.allowHighRisk !== true || user.allowHighRisk !== true),
  },
];
const denial = (tool: AnyProviderToolDescriptor, principals: Principals) =>
  Option.map(
    EffectArray.findFirst(denialRules, ({ refuses }) => refuses(tool, principals)),
    ({ reason }) => ProviderToolPolicyDenied.make({ toolId: tool.id, reason }),
  );
const noTrustedAuthority: ProviderToolTrustedAuthority = Object.freeze({
  workspace: false,
  isolatedCompute: false,
  isolatedDesktop: false,
  principalStorage: false,
});
export const hasRequiredProviderToolAuthority: {
  (tool: AnyProviderToolDescriptor, authority?: ProviderToolTrustedAuthority): boolean;
  (authority?: ProviderToolTrustedAuthority): (tool: AnyProviderToolDescriptor) => boolean;
} = EffectFunction.dual(
  (args) =>
    args.length > 1 || (Predicate.isReadonlyObject(args[0]) && Array.isArray(args[0].sandbox)),
  hasRequiredProviderToolAuthorityBody,
);
/** The trusted authority each sandbox requirement needs; `null` for one the provider meets. */
const sandboxAuthority = {
  provider_hosted: null,
  remote_trust_boundary: null,
  isolated_compute_required: "isolatedCompute",
  isolated_desktop_required: "isolatedDesktop",
  workspace_required: "workspace",
  principal_storage_required: "principalStorage",
} as const satisfies Record<ProviderToolSandbox, keyof ProviderToolTrustedAuthority | null>;
function hasRequiredProviderToolAuthorityBody(
  tool: AnyProviderToolDescriptor,
  authority: ProviderToolTrustedAuthority = noTrustedAuthority,
): boolean {
  return tool.sandbox.every((requirement) =>
    Option.match(Option.fromNullishOr(sandboxAuthority[requirement]), {
      onNone: () => true,
      onSome: (needed) => authority[needed],
    }),
  );
}
export const decideProviderToolExposure: {
  (
    tools: readonly AnyProviderToolDescriptor[],
    context: ProviderToolPolicyContext,
  ): ProviderToolExposureDecision;
  (
    tools: readonly AnyProviderToolDescriptor[],
    context: ProviderToolPolicyContext,
    authority: ProviderToolTrustedAuthority | undefined,
  ): ProviderToolExposureDecision;
  (
    context: ProviderToolPolicyContext,
  ): (tools: readonly AnyProviderToolDescriptor[]) => ProviderToolExposureDecision;
  (
    context: ProviderToolPolicyContext,
    authority: ProviderToolTrustedAuthority | undefined,
  ): (tools: readonly AnyProviderToolDescriptor[]) => ProviderToolExposureDecision;
} = EffectFunction.dual((args) => Array.isArray(args[0]), decideProviderToolExposureBody);
function decideProviderToolExposureBody(
  tools: readonly AnyProviderToolDescriptor[],
  context: ProviderToolPolicyContext,
  authority: ProviderToolTrustedAuthority = noTrustedAuthority,
): ProviderToolExposureDecision {
  return Object.freeze({
    tools: Object.freeze(
      tools
        .filter(
          (tool) =>
            Option.isNone(denial(tool, context)) &&
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
const executionOptionKeys = HashSet.fromIterable([
  "paths",
  "networkRequested",
  "environmentNames",
  "timeoutMs",
  "maxOutputBytes",
  "maxMemoryBytes",
  "maxProcesses",
]);
const pathRequestKeys = HashSet.fromIterable(["path", "access", "target"]);
function validateSandbox(
  tool: AnyProviderToolDescriptor,
  options: ProviderToolExecutionOptions,
  sandbox: ProviderToolSandboxPolicy | undefined,
): Effect.Effect<string | null, ValidationFailure, FileSystem.FileSystem> {
  const sandboxViolation = (reason: ProviderToolSandboxViolation["reason"]) =>
    ProviderToolSandboxViolation.make({ toolId: tool.id, reason });
  const optionsViolation = (reason: ProviderToolOptionsViolation["reason"]) =>
    ProviderToolOptionsViolation.make({ toolId: tool.id, reason });
  const appManaged = tool.sandbox.some((requirement) => sandboxAuthority[requirement] !== null);
  const environment = options.environmentNames ?? [];
  const limits = sandbox?.limits;
  const requests = [
    ["timeout", options.timeoutMs, limits?.timeoutMs],
    ["output", options.maxOutputBytes, limits?.maxOutputBytes],
    ["memory", options.maxMemoryBytes, limits?.maxMemoryBytes],
    ["processes", options.maxProcesses, limits?.maxProcesses],
  ] as const;
  /** A path the call asks for, inside the workspace and not a credential. */
  const checkedPath = (request: ProviderToolPathRequest, root: Option.Option<string>) =>
    Effect.gen(function* () {
      const pathViolation = (reason: ProviderToolPathViolation["reason"]) =>
        ProviderToolPathViolation.make({ toolId: tool.id, path: request.path, reason });
      yield* Effect.when(
        Effect.fail(optionsViolation("path_request_invalid")),
        Effect.succeed(Object.keys(request).some((key) => !HashSet.has(pathRequestKeys, key))),
      );
      const trustedRoot = yield* Effect.fromOption(root, () =>
        sandboxViolation("trusted_profile_required"),
      );
      yield* Effect.when(
        Effect.fail(pathViolation("absolute_path")),
        Effect.succeed(oauthProtocolPath.isAbsolute(request.path)),
      );
      yield* Effect.when(
        Effect.fail(pathViolation("credential_path")),
        Effect.succeed(isCredentialPath(request.path)),
      );
      yield* resolveProjectPath(trustedRoot, request.path, request.target).pipe(
        Effect.catchTags({
          PathRejected: (rejection) => Effect.fail(pathViolation(rejection.reason)),
          PlatformError: (cause) =>
            Effect.fail(
              ProviderToolPathViolation.make({
                toolId: tool.id,
                path: request.path,
                reason: "inspection_failed",
                cause,
              }),
            ),
        }),
      );
    });
  return Effect.gen(function* () {
    yield* Effect.when(
      Effect.fail(optionsViolation("unknown_policy_option")),
      Effect.succeed(Object.keys(options).some((key) => !HashSet.has(executionOptionKeys, key))),
    );
    yield* Effect.when(
      Effect.fail(sandboxViolation("trusted_profile_required")),
      Effect.succeed(appManaged && sandbox === undefined),
    );
    const root = yield* Option.match(Option.fromNullishOr(sandbox), {
      onNone: () => Effect.succeedNone,
      onSome: (trusted) =>
        canonicalPathEffect(trusted.workspaceRoot).pipe(
          Effect.mapError((cause) =>
            ProviderToolSandboxViolation.make({
              toolId: tool.id,
              reason: "workspace_root_unavailable",
              cause,
            }),
          ),
          Effect.asSome,
        ),
    });
    yield* Effect.when(
      Effect.fail(sandboxViolation("isolated_compute_required")),
      Effect.succeed(
        tool.sandbox.includes("isolated_compute_required") && sandbox?.isolatedCompute !== true,
      ),
    );
    yield* Effect.when(
      Effect.fail(sandboxViolation("isolated_desktop_required")),
      Effect.succeed(
        tool.sandbox.includes("isolated_desktop_required") && sandbox?.isolatedDesktop !== true,
      ),
    );
    if (
      options.networkRequested === true &&
      tool.sandbox.includes("provider_hosted") === false &&
      sandbox?.network !== "restricted"
    ) {
      return yield* sandboxViolation("network_denied");
    }
    if (
      environment.length > 0 &&
      (sandbox?.environment !== "allowlisted_names" ||
        environment.some((name) => !sandbox.allowedEnvironmentNames.includes(name)))
    ) {
      return yield* sandboxViolation("environment_denied");
    }
    yield* Effect.forEach(
      requests,
      ([name, value, maximum]) =>
        Effect.when(
          Effect.fail(optionsViolation(`${name}_limit_invalid`)),
          Effect.succeed(
            value !== undefined &&
              (!Number.isSafeInteger(value) ||
                value <= 0 ||
                maximum === undefined ||
                value > maximum),
          ),
        ),
      { discard: true },
    );
    yield* Effect.when(
      Effect.fail(sandboxViolation("local_access_not_applicable")),
      Effect.succeed((options.paths?.length ?? 0) > 0 && !appManaged),
    );
    yield* Effect.forEach(options.paths ?? [], (request) => checkedPath(request, root), {
      discard: true,
    });
    return appManaged ? Option.getOrNull(root) : null;
  });
}

/** A call that needs approval goes on only once it is granted. */
const approvalOutcome = ({
  toolId,
  approval,
}: ProviderToolExecutionRevalidationInput): Effect.Effect<
  void,
  ProviderToolApprovalRequired | ProviderToolApprovalDenied | ProviderToolApprovalCancelled
> =>
  Match.value(approval).pipe(
    Match.when("not_requested", () => Effect.fail(ProviderToolApprovalRequired.make({ toolId }))),
    Match.when("denied", () => Effect.fail(ProviderToolApprovalDenied.make({ toolId }))),
    Match.when("cancelled", () => Effect.fail(ProviderToolApprovalCancelled.make({ toolId }))),
    Match.orElse(() => Effect.void),
  );
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
  return sandbox === undefined
    ? undefined
    : Object.freeze({
        ...sandbox,
        workspaceRoot: oauthProtocolPath.resolve(sandbox.workspaceRoot),
        allowedEnvironmentNames: Object.freeze([...sandbox.allowedEnvironmentNames]),
        limits: Object.freeze({ ...sandbox.limits }),
      });
};
export function makeProviderToolPolicy(options: {
  readonly registry: ProviderToolCapabilityRegistry["Service"];
  /** Checks the trusted workspace and the paths a call asks for. */
  readonly fileSystem: FileSystem.FileSystem;
  readonly config?: ProviderToolPolicyConfig | undefined;
  readonly featureFlags?: ModelFeatureFlagsApi | undefined;
}) {
  return makeProviderToolPolicyBody(
    options.registry,
    options.fileSystem,
    options.config,
    options.featureFlags,
  );
}
function makeProviderToolPolicyBody(
  registry: ProviderToolCapabilityRegistry["Service"],
  fileSystem: FileSystem.FileSystem,
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
    ProviderToolUnsupported.make({
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
              ...optionalProperty("route", context.route),
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
            ...optionalProperty("route", context.route),
          }),
          (decision) =>
            decision.allowed
              ? Effect.void
              : Effect.fail(
                  ProviderToolPolicyDenied.make({
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
        const tool = yield* registry.get(input.toolId).pipe(
          Effect.mapError(() => unsupported(input.toolId, input.policy, "unknown_tool")),
          Effect.filterOrFail(
            (found) =>
              found.provider === input.provider &&
              input.policy.provider === input.provider &&
              found.kind === input.kind,
            () =>
              ProviderToolOptionsViolation.make({
                toolId: input.toolId,
                reason: "tool_identity_mismatch",
              }),
          ),
        );
        const offers = (tools: readonly AnyProviderToolDescriptor[]) =>
          tools.some((entry) => entry.id === tool.id);
        yield* assertFeatureFlag(tool, input.policy);
        yield* registry.resolve({ provider: input.provider, model: input.policy.model }).pipe(
          Effect.mapError(() => unsupported(input.toolId, input.policy, "unknown_model")),
          Effect.filterOrFail(offers, () =>
            unsupported(input.toolId, input.policy, "model_unsupported"),
          ),
        );
        yield* resolveAccount(input.policy).pipe(
          Effect.filterOrFail(offers, () =>
            ProviderToolCapabilityDenied.make({
              toolId: input.toolId,
              provider: input.policy.provider,
              model: input.policy.model,
              reason: "account_unsupported",
            }),
          ),
        );
        yield* Option.match(denial(tool, input.policy), {
          onNone: () => Effect.void,
          onSome: Effect.fail,
        });
        const exposed = publicDescriptor(tool);
        yield* Effect.when(approvalOutcome(input), Effect.succeed(exposed.requiresApproval));
        const workspaceRoot = yield* validateSandbox(tool, input.options, sandbox).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        return Object.freeze({ tool: exposed, workspaceRoot });
      }),
  };
}
export class ProviderToolPolicy extends Context.Service<
  ProviderToolPolicy,
  ProviderToolPolicyApi
>()("memory-agent/providers/tool-policy/ProviderToolPolicy") {
  /** Production default: provider-hosted tools only; no local authority is granted. */
  static readonly layer = Layer.effect(
    ProviderToolPolicy,
    Effect.gen(function* () {
      return makeProviderToolPolicy({
        registry: yield* ProviderToolCapabilityRegistry,
        fileSystem: yield* FileSystem.FileSystem,
      });
    }),
  );
  /** Production flag-aware policy. Both model exposure and execution revalidation read fresh flags. */
  static readonly featureFlagLayer = Layer.effect(
    ProviderToolPolicy,
    Effect.gen(function* () {
      return makeProviderToolPolicy({
        registry: yield* ProviderToolCapabilityRegistry,
        fileSystem: yield* FileSystem.FileSystem,
        config: {},
        featureFlags: yield* ModelFeatureFlags,
      });
    }),
  );
  static readonly featureFlagLayerWithConfig = (config: ProviderToolPolicyConfig) =>
    Layer.effect(
      ProviderToolPolicy,
      Effect.gen(function* () {
        return makeProviderToolPolicy({
          registry: yield* ProviderToolCapabilityRegistry,
          fileSystem: yield* FileSystem.FileSystem,
          config: config,
          featureFlags: yield* ModelFeatureFlags,
        });
      }),
    );
  /** Construct a policy Layer from trusted server configuration. */
  static readonly layerWithConfig = (config: ProviderToolPolicyConfig) =>
    Layer.effect(
      ProviderToolPolicy,
      Effect.gen(function* () {
        return makeProviderToolPolicy({
          registry: yield* ProviderToolCapabilityRegistry,
          fileSystem: yield* FileSystem.FileSystem,
          config: config,
        });
      }),
    );
  static readonly layerFrom = (service: ProviderToolPolicyApi) =>
    Layer.succeed(ProviderToolPolicy, service);
}

type InstalledDescriptor = (typeof providerToolDescriptors)[number];
type DescriptorFor<Id extends ProviderToolId> = Extract<InstalledDescriptor, { readonly id: Id }>;

/** A provider tool asked for, with its configuration (`acceptsConfig` checks it). */
export const ProviderToolRequest = Schema.Struct({
  id: ProviderToolId,
  config: ProviderToolConfig,
});
export type ProviderToolRequest = typeof ProviderToolRequest.Type;

export interface ComposedProviderTool<Id extends ProviderToolId = ProviderToolId> {
  readonly id: Id;
  readonly descriptor: DescriptorFor<Id>;
  /** The tool for the model. */
  readonly modelTool: Tool.Any;
}
export class ProviderToolNotExposed extends Schema.TaggedError<ProviderToolNotExposed>()(
  "ProviderToolNotExposed",
  { toolId: Schema.String, provider: ProviderVendor, model: Schema.String },
) {}
export class ProviderToolFactoryOptionsFailure extends Schema.TaggedError<ProviderToolFactoryOptionsFailure>()(
  "ProviderToolFactoryOptionsFailure",
  { toolId: Schema.String, reason: Schema.Literals(["invalid_request", "provider_mismatch"]) },
) {}
export class ProviderToolOperationFailure extends Schema.TaggedError<ProviderToolOperationFailure>()(
  "ProviderToolOperationFailure",
  {
    toolId: ProviderToolId,
    reason: Schema.Literals([
      /** A provider-hosted tool was executed without its operation. */
      "operation_missing",
      /** The operation rejected; `cause` has its error. */
      "operation_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export class ProviderToolLeaseFailure extends Schema.TaggedError<ProviderToolLeaseFailure>()(
  "ProviderToolLeaseFailure",
  {
    toolId: ProviderToolId,
    phase: Schema.Literals(["acquire", "release"]),
    cause: Schema.Defect(),
  },
) {}
export class ProviderToolLifecycleFailure extends Schema.TaggedError<ProviderToolLifecycleFailure>()(
  "ProviderToolLifecycleFailure",
  { toolId: ProviderToolId, cause: Schema.Defect() },
) {}
export class ProviderToolNormalizationFailure extends Schema.TaggedError<ProviderToolNormalizationFailure>()(
  "ProviderToolNormalizationFailure",
  { toolId: ProviderToolId, cause: Schema.Defect() },
) {}
export class ProviderToolPolicyPropagationFailure extends Schema.TaggedError<ProviderToolPolicyPropagationFailure>()(
  "ProviderToolPolicyPropagationFailure",
  {
    toolId: Schema.optionalKey(ProviderToolId),
    cause: Schema.Union([
      ProviderToolUnsupported,
      ProviderToolCapabilityDenied,
      ProviderToolPolicyDenied,
      ProviderToolApprovalRequired,
      ProviderToolApprovalDenied,
      ProviderToolApprovalCancelled,
      ProviderToolSandboxViolation,
      ProviderToolPathViolation,
      ProviderToolOptionsViolation,
      UnknownModelFeatureCapability,
      ModelFeatureFlagStoreFailed,
    ]),
  },
) {}
export type ProviderToolLifecycleStatus =
  | "pending"
  | "approval-required"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface ProviderToolUsageAttribution {
  readonly provider: ProviderToolVendor;
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
  readonly provider: ProviderToolVendor;
  readonly toolId: ProviderToolId;
  readonly kind: ProviderToolKind;
  readonly workspaceRoot: string | null;
}
export interface ProviderToolResultEnvelope<Raw = unknown> {
  readonly provider: ProviderToolVendor;
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
export interface ProviderToolLease<E = never> {
  readonly release: Effect.Effect<void, E>;
}
export interface ProviderToolOperationContext {
  readonly workspaceRoot: string | null;
  readonly progress: <Raw>(event: ProviderToolOperationResult<Raw>) => Effect.Effect<void>;
}
export interface ProviderToolExecutionRequest<Raw = unknown, E = never> {
  readonly policy: ProviderToolPolicyContext;
  readonly toolId: ProviderToolId;
  readonly kind: string;
  readonly accountId: string;
  readonly runId: string;
  readonly options: ProviderToolExecutionOptions;
  readonly approval: ProviderToolApprovalState;
  /**
   * Invoked only for provider-hosted or hybrid tools; caller-loop tools return action metadata.
   * Cancelling the execution interrupts it.
   */
  readonly operation?: (
    context: ProviderToolOperationContext,
  ) => Effect.Effect<ProviderToolOperationResult<Raw>, E>;
  readonly acquire?: Effect.Effect<ProviderToolLease<E>, E>;
  readonly onLifecycle?: (event: ProviderToolResultEnvelope) => Effect.Effect<void, E>;
}
export type ProviderToolRuntimeFailure =
  | ProviderToolPolicyFailure
  | ProviderToolNotExposed
  | ProviderToolFactoryOptionsFailure
  | ProviderToolOperationFailure
  | ProviderToolLeaseFailure
  | ProviderToolLifecycleFailure
  | ProviderToolNormalizationFailure
  | ProviderToolPolicyPropagationFailure;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Provider SDK payloads are intentionally opaque; normalization reads optional reported counters while retaining the exact raw value. */
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isReadonlyObject(value) ? value : undefined;
const firstNumber = (source: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  keys.map((key) => finite(source[key])).find((found) => found !== undefined);
const numberRecord = (value: unknown): Readonly<Record<string, number>> | undefined => {
  const entries = Object.entries(objectRecord(value) ?? {}).filter(
    (entry): entry is [string, number] => finite(entry[1]) !== undefined,
  );
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
};
/** Normalize reported values only; never estimate absent tokens or cost. */
export function normalizeProviderToolUsage(options: {
  readonly raw: unknown;
  readonly attribution?: ProviderToolUsageAttribution | undefined;
}) {
  return normalizeProviderToolUsageBody(options.raw, options.attribution);
}
function normalizeProviderToolUsageBody(
  raw: unknown,
  attribution?: ProviderToolUsageAttribution,
): ProviderToolUsage | undefined {
  const source = objectRecord(raw);
  return source === undefined
    ? undefined
    : Object.freeze({
        ...optionalProperty(
          "attribution",
          attribution === undefined ? undefined : Object.freeze({ ...attribution }),
        ),
        ...optionalProperty(
          "inputTokens",
          firstNumber(source, ["inputTokens", "input_tokens", "promptTokens"]),
        ),
        ...optionalProperty(
          "outputTokens",
          firstNumber(source, ["outputTokens", "output_tokens", "completionTokens"]),
        ),
        ...optionalProperty("totalTokens", firstNumber(source, ["totalTokens", "total_tokens"])),
        ...optionalProperty(
          "cacheReadTokens",
          firstNumber(source, ["cacheReadTokens", "cache_read_input_tokens", "cachedTokens"]),
        ),
        ...optionalProperty(
          "cacheWriteTokens",
          firstNumber(source, ["cacheWriteTokens", "cache_creation_input_tokens"]),
        ),
        ...optionalProperty(
          "serverToolRequests",
          numberRecord(source.serverToolRequests) ??
            numberRecord(source.server_tool_requests) ??
            numberRecord(source.server_tool_use),
        ),
        raw,
      });
}
export function normalizeProviderToolCost(raw: unknown): ProviderToolCost | undefined {
  // Anything but an object reports no amount.
  const source = objectRecord(raw) ?? {};
  const amount = finite(source.amount) ?? finite(source.cost);
  return amount === undefined
    ? undefined
    : Object.freeze({
        amount,
        ...optionalProperty(
          "currency",
          typeof source.currency === "string" ? source.currency : undefined,
        ),
        raw,
      });
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
const providerStatus = HashMap.fromIterable<string, ProviderToolLifecycleStatus>([
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
export const normalizeProviderToolLifecycleStatus: {
  (
    fallback: ProviderToolLifecycleStatus,
  ): (kind: string | undefined) => ReturnType<typeof normalizeProviderToolLifecycleStatusBody>;
} & typeof normalizeProviderToolLifecycleStatusBody = EffectFunction.dual(
  2,
  normalizeProviderToolLifecycleStatusBody,
);
function normalizeProviderToolLifecycleStatusBody(
  kind: string | undefined,
  fallback: ProviderToolLifecycleStatus,
): ProviderToolLifecycleStatus {
  return Option.fromNullishOr(kind).pipe(
    Option.flatMap((reported) => HashMap.get(providerStatus, reported)),
    Option.getOrElse(() => fallback),
  );
}
const runtimeEnvelope = <Raw>(
  request: Pick<ProviderToolExecutionRequest, "policy" | "accountId" | "runId">,
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
    ...optionalProperty("providerKind", result.kind),
    unknownKind: result.kind !== undefined && !HashMap.has(providerStatus, result.kind),
    ...optionalProperty(
      "usage",
      normalizeProviderToolUsage({
        raw: result.usage,
        attribution: {
          provider: descriptor.provider,
          model: request.policy.model,
          accountId: request.accountId,
          toolId: descriptor.id,
          runId: request.runId,
        },
      }),
    ),
    ...optionalProperty("cost", normalizeProviderToolCost(result.cost)),
    raw: result.raw,
  });
};
export interface ProviderToolRuntimeApi {
  readonly compose: (
    policy: ProviderToolPolicyContext,
    requests?: readonly ProviderToolRequest[],
  ) => Effect.Effect<
    readonly ComposedProviderTool[],
    ProviderToolPolicyFailure | ProviderToolNotExposed | ProviderToolFactoryOptionsFailure
  >;
  readonly execute: <Raw, E = never>(
    request: ProviderToolExecutionRequest<Raw, E>,
  ) => Effect.Effect<ProviderToolResultEnvelope<Raw | undefined>, ProviderToolRuntimeFailure>;
}
const isProviderToolRequest = Schema.is(ProviderToolRequest);
const requestKeys = HashSet.fromIterable(["id", "config"]);
export const makeProviderToolRuntime: {
  (
    policyService: ProviderToolPolicy["Service"],
  ): (
    registry: ProviderToolCapabilityRegistry["Service"],
  ) => ReturnType<typeof makeProviderToolRuntimeBody>;
} & typeof makeProviderToolRuntimeBody = EffectFunction.dual(2, makeProviderToolRuntimeBody);
function makeProviderToolRuntimeBody(
  registry: ProviderToolCapabilityRegistry["Service"],
  policyService: ProviderToolPolicy["Service"],
): ProviderToolRuntimeApi {
  return {
    compose: (context, requests = []) =>
      Effect.gen(function* () {
        const exposed = yield* policyService.expose(context);
        const allowed = HashSet.fromIterable(exposed.tools.map((tool) => tool.id));
        const notExposed = (toolId: string) =>
          ProviderToolNotExposed.make({ toolId, provider: context.provider, model: context.model });
        const composed = (request: ProviderToolRequest) =>
          Effect.succeed(request).pipe(
            Effect.filterOrFail(
              (candidate) =>
                isProviderToolRequest(candidate) &&
                Object.keys(candidate).every((key) => HashSet.has(requestKeys, key)),
              () =>
                ProviderToolFactoryOptionsFailure.make({
                  toolId: String(request.id),
                  reason: "invalid_request",
                }),
            ),
            Effect.filterOrFail(
              ({ id }) => id.startsWith(`${context.provider}:`),
              ({ id }) =>
                ProviderToolFactoryOptionsFailure.make({ toolId: id, reason: "provider_mismatch" }),
            ),
            Effect.filterOrFail(acceptsConfig, ({ id }) =>
              ProviderToolOptionsViolation.make({ toolId: id, reason: "invalid_factory_options" }),
            ),
            Effect.filterOrFail(
              ({ id }) => HashSet.has(allowed, id),
              ({ id }) => notExposed(id),
            ),
            Effect.andThen(
              registry.get(request.id).pipe(Effect.mapError(() => notExposed(request.id))),
            ),
            // SAFETY: registry.get returned the same provider-qualified id carried by the request.
            Effect.map(
              (descriptor) =>
                ({
                  id: request.id,
                  descriptor,
                  modelTool: providerTools[request.id](request.config),
                }) as ComposedProviderTool,
            ),
          );
        return Object.freeze(
          yield* Effect.forEach(
            requests.toSorted((left, right) => left.id.localeCompare(right.id)),
            composed,
          ),
        );
      }),
    execute: (request) =>
      Effect.gen(function* () {
        const descriptor = yield* registry.get(request.toolId).pipe(
          Effect.mapError(() =>
            ProviderToolNotExposed.make({
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
        const notify = (envelope: ProviderToolResultEnvelope) =>
          (request.onLifecycle ?? (() => Effect.void))(envelope).pipe(
            Effect.mapError((cause) =>
              ProviderToolLifecycleFailure.make({ toolId: request.toolId, cause }),
            ),
          );
        const lifecycle = (
          status: ProviderToolLifecycleStatus,
          result: ProviderToolOperationResult,
        ) => notify(runtimeEnvelope(request, descriptor, status, result));
        // A caller-loop tool is only described; the caller runs it.
        const described = Effect.as(
          lifecycle("pending", { raw: undefined }),
          Object.freeze({
            ...runtimeEnvelope(request, descriptor, "pending", { raw: undefined }),
            action: Object.freeze({
              mode: "future_executor" as const,
              provider: descriptor.provider,
              toolId: descriptor.id,
              kind: descriptor.kind,
              workspaceRoot: decision.workspaceRoot,
            }),
          }),
        );
        const acquire = (
          request.acquire ?? Effect.succeed<ProviderToolLease<never>>({ release: Effect.void })
        ).pipe(
          Effect.mapError((cause) =>
            ProviderToolLeaseFailure.make({ toolId: request.toolId, phase: "acquire", cause }),
          ),
        );
        const use = (operation: NonNullable<typeof request.operation>) =>
          Effect.gen(function* () {
            yield* lifecycle("running", { raw: undefined });
            const progress = yield* Ref.make<ReadonlyArray<ProviderToolOperationResult>>([]);
            const operationExit = yield* operation({
              workspaceRoot: decision.workspaceRoot,
              progress: (event) => Ref.update(progress, EffectArray.append(event)),
            }).pipe(
              Effect.mapError((cause) =>
                ProviderToolOperationFailure.make({
                  toolId: request.toolId,
                  reason: "operation_failed",
                  cause,
                }),
              ),
              Effect.exit,
            );
            yield* Effect.forEach(
              yield* Ref.get(progress),
              (event) => lifecycle("running", event),
              {
                discard: true,
              },
            );
            const completed = runtimeEnvelope(
              request,
              descriptor,
              "succeeded",
              yield* operationExit,
            );
            yield* notify(completed);
            return completed;
          });
        const run = (operation: NonNullable<typeof request.operation>) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const lease = yield* restore(acquire);
              const useExit = yield* restore(use(operation)).pipe(Effect.exit);
              yield* Exit.match(useExit, {
                onSuccess: () => Effect.void,
                onFailure: (cause) =>
                  lifecycle(Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed", {
                    raw: undefined,
                  }),
              });
              yield* lease.release.pipe(
                Effect.mapError((cause) =>
                  ProviderToolLeaseFailure.make({
                    toolId: request.toolId,
                    phase: "release",
                    cause,
                  }),
                ),
              );
              return yield* useExit;
            }),
          );
        return yield* descriptor.execution === "caller_loop"
          ? described
          : Effect.fromOption(Option.fromNullishOr(request.operation), () =>
              ProviderToolOperationFailure.make({
                toolId: request.toolId,
                reason: "operation_missing",
              }),
            ).pipe(Effect.flatMap(run));
      }),
  };
}
export class ProviderToolRuntime extends Context.Service<
  ProviderToolRuntime,
  ProviderToolRuntimeApi
>()("memory-agent/providers/tool-policy/ProviderToolRuntime") {
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
