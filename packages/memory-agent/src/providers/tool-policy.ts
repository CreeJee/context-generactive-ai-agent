import { HashSet, Iterable } from "effect";
import { Function as EffectFunction } from "effect";
import { optionalProperty } from "../optional-property.ts";
import { Option, Context, Effect, Layer, Match, Predicate, Schema } from "effect";
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
  type ProviderToolSandbox,
  type ProviderToolVendor,
} from "./tool-capabilities.ts";
import { ProviderToolId, type ProviderToolKind } from "./provider-tool-id.ts";
import { ProviderToolConfig, acceptsConfig, providerTools } from "./provider-tools.ts";
import type { Tool } from "effect/ai";

export type ProviderToolRisk = "read_only" | "elevated" | "high";
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
/** A trusted workspace; having one grants workspace authority. */
export interface ProviderToolSandboxPolicy {
  readonly isolatedCompute: boolean;
  readonly isolatedDesktop: boolean;
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
export class ProviderToolUnsupported extends Schema.TaggedError<
  ProviderToolUnsupported,
  { readonly brand: unique symbol }
>()("ProviderToolUnsupported", {
  toolId: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  reason: Schema.Literals(["unknown_model"]),
}) {}
export class ProviderToolOptionsViolation extends Schema.TaggedError<
  ProviderToolOptionsViolation,
  { readonly brand: unique symbol }
>()("ProviderToolOptionsViolation", {
  toolId: Schema.String,
  reason: Schema.Literals(["invalid_factory_options"]),
}) {}
export type ProviderToolPolicyFailure =
  | ProviderToolUnsupported
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
/** The principals' checks; a tool any of them refuses is not offered. */
const refusals: ReadonlyArray<
  (tool: AnyProviderToolDescriptor, principals: Principals) => boolean
> = [
  // Disabled by the app or the user.
  (tool, { app }) => toolExcluded(app, tool.id),
  (tool, { user }) => toolExcluded(user, tool.id),
  (tool, { app, user }) =>
    categoryExcluded(app, tool.category) || categoryExcluded(user, tool.category),
  // Network and provider files.
  (tool, { app, user }) =>
    tool.dataAccess.includes("public_network") &&
    (app.allowNetwork === false || user.allowNetwork === false),
  (tool, { app, user }) =>
    tool.dataAccess.includes("provider_files") &&
    (app.allowProviderFiles !== true || user.allowProviderFiles !== true),
  // High risk.
  (tool, { app, user }) =>
    classifyProviderToolRisk(tool) === "high" &&
    (app.allowHighRisk !== true || user.allowHighRisk !== true),
];
const refused = (tool: AnyProviderToolDescriptor, principals: Principals) =>
  refusals.some((refuses) => refuses(tool, principals));
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
          (tool) => !refused(tool, context) && hasRequiredProviderToolAuthority(tool, authority),
        )
        .map(publicDescriptor)
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

export interface ProviderToolPolicyApi {
  readonly expose: (
    context: ProviderToolPolicyContext,
  ) => Effect.Effect<ProviderToolExposureDecision, ProviderToolPolicyFailure>;
}
export function makeProviderToolPolicy(options: {
  readonly registry: ProviderToolCapabilityRegistry["Service"];
  readonly config?: ProviderToolPolicyConfig | undefined;
  readonly featureFlags?: ModelFeatureFlagsApi | undefined;
}) {
  return makeProviderToolPolicyBody(options.registry, options.config, options.featureFlags);
}
function makeProviderToolPolicyBody(
  registry: ProviderToolCapabilityRegistry["Service"],
  config: ProviderToolPolicyConfig = {},
  featureFlags?: ModelFeatureFlagsApi,
): ProviderToolPolicyApi {
  const authority: ProviderToolTrustedAuthority = Object.freeze({
    workspace: config.sandbox !== undefined,
    isolatedCompute: config.sandbox?.isolatedCompute === true,
    isolatedDesktop: config.sandbox?.isolatedDesktop === true,
    principalStorage: config.principalStorage === true,
  });
  const resolveAccount = (context: ProviderToolPolicyContext) =>
    registry
      .resolve({
        provider: context.provider,
        model: context.model,
        accountToolKinds: context.accountToolKinds,
      })
      .pipe(
        Effect.mapError(() =>
          ProviderToolUnsupported.make({
            toolId: "*",
            provider: context.provider,
            model: context.model,
            reason: "unknown_model",
          }),
        ),
      );
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
  return {
    expose: (context) =>
      Effect.map(
        Effect.flatMap(resolveAccount(context), (tools) => applyFeatureFlags(tools, context)),
        (tools) => decideProviderToolExposure(tools, context, authority),
      ),
  };
}
export class ProviderToolPolicy extends Context.Service<
  ProviderToolPolicy,
  ProviderToolPolicyApi
>()("memory-agent/providers/tool-policy/ProviderToolPolicy") {
  /** Production default: provider-hosted tools only; no local authority is granted. */
  static readonly layer = Layer.effect(
    ProviderToolPolicy,
    Effect.map(ProviderToolCapabilityRegistry, (registry) => makeProviderToolPolicy({ registry })),
  );
  /** Production flag-aware policy. Exposure reads the flags fresh each time. */
  static readonly featureFlagLayer = Layer.effect(
    ProviderToolPolicy,
    Effect.gen(function* () {
      return makeProviderToolPolicy({
        registry: yield* ProviderToolCapabilityRegistry,
        featureFlags: yield* ModelFeatureFlags,
      });
    }),
  );
  /** Construct a policy Layer from trusted server configuration. */
  static readonly layerWithConfig = (config: ProviderToolPolicyConfig) =>
    Layer.effect(
      ProviderToolPolicy,
      Effect.map(ProviderToolCapabilityRegistry, (registry) =>
        makeProviderToolPolicy({ registry, config }),
      ),
    );
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
export class ProviderToolNotExposed extends Schema.TaggedError<
  ProviderToolNotExposed,
  { readonly brand: unique symbol }
>()("ProviderToolNotExposed", {
  toolId: Schema.String,
  provider: ProviderVendor,
  model: Schema.String,
}) {}
export class ProviderToolFactoryOptionsFailure extends Schema.TaggedError<
  ProviderToolFactoryOptionsFailure,
  { readonly brand: unique symbol }
>()("ProviderToolFactoryOptionsFailure", {
  toolId: Schema.String,
  reason: Schema.Literals(["invalid_request", "provider_mismatch"]),
}) {}
export interface ProviderToolRuntimeApi {
  readonly compose: (
    policy: ProviderToolPolicyContext,
    requests?: readonly ProviderToolRequest[],
  ) => Effect.Effect<
    readonly ComposedProviderTool[],
    | ProviderToolPolicyFailure
    | ProviderToolNotExposed
    | ProviderToolFactoryOptionsFailure
    | ProviderToolOptionsViolation
  >;
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
        const allowed = HashSet.fromIterable(Iterable.map(exposed.tools, (tool) => tool.id));
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
}
