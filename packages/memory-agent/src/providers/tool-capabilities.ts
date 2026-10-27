import {
  Array as EffectArray,
  Function as EffectFunction,
  HashMap,
  HashSet,
  Option,
  Context,
  Effect,
  Layer,
  Schema,
} from "effect";
import { ProviderVendor } from "./contracts.ts";
import {
  ANTHROPIC_MODELS,
  OPENAI_CHAT_MODELS,
  type AnthropicChatModel,
  type OpenAIChatModel,
} from "./model-catalog.ts";
import type {
  AnthropicProviderToolKind,
  OpenAIProviderToolKind,
  ProviderToolId,
  ProviderToolKind,
} from "./provider-tool-id.ts";
import {
  anthropicModelToolCapabilities,
  openAIModelToolCapabilities,
} from "./model-tool-capabilities.ts";

/** Vendor namespace of native tool schemas; availability is resolved separately. */
export type ProviderToolVendor = ProviderVendor;
export type ProviderToolCategory =
  | "network.search"
  | "network.fetch"
  | "data.provider_files.read"
  | "execution.hosted_code"
  | "execution.shell"
  | "computer.control"
  | "filesystem.write"
  | "memory.read_write"
  | "media.image.generate"
  | "integration.mcp.remote"
  | "provider.custom";
export type ProviderToolExecution = "provider_hosted" | "caller_loop" | "hybrid";
export type ProviderToolAuth =
  | "provider_account"
  | "provider_account_resource_acl"
  | "provider_account_beta_entitlement"
  | "provider_account_and_remote_credentials";
export type ProviderToolCost = "provider_metered" | "provider_metered_high_variance";
export type ProviderToolDataAccess =
  | "public_network"
  | "provider_files"
  | "provider_container"
  | "remote_integration"
  | "screen"
  | "workspace_files"
  | "application_memory"
  | "application_defined";
export type ProviderToolSideEffect = "none" | "external_read" | "stateful_execution" | "write";
export type ProviderToolApproval =
  | "none"
  | "run_optional"
  | "action_required"
  | "provider_interrupt";
export type ProviderToolSandbox =
  | "provider_hosted"
  | "remote_trust_boundary"
  | "isolated_compute_required"
  | "isolated_desktop_required"
  | "workspace_required"
  | "principal_storage_required";
export interface ProviderToolResultNormalizerMetadata {
  readonly strategy: "provider_native_preserve";
  readonly preservesUnknownParts: true;
  readonly usage: "request_and_model_usage_when_reported";
}
export interface ProviderToolDescriptor<
  TProvider extends ProviderToolVendor = ProviderToolVendor,
  TKind extends ProviderToolKind = ProviderToolKind,
> {
  readonly id: `${TProvider}:${TKind}`;
  readonly provider: TProvider;
  readonly kind: TKind;
  readonly category: ProviderToolCategory;
  readonly execution: ProviderToolExecution;
  readonly modelSupport: "installed_metadata_exact";
  readonly auth: readonly ProviderToolAuth[];
  readonly cost: ProviderToolCost;
  readonly dataAccess: readonly ProviderToolDataAccess[];
  readonly sideEffect: ProviderToolSideEffect;
  readonly approval: ProviderToolApproval;
  readonly sandbox: readonly ProviderToolSandbox[];
  readonly resultNormalizer: ProviderToolResultNormalizerMetadata;
}
export type AnyProviderToolDescriptor =
  | ProviderToolDescriptor<"openai", OpenAIProviderToolKind>
  | ProviderToolDescriptor<"anthropic", AnthropicProviderToolKind>;

const normalizer = Object.freeze({
  strategy: "provider_native_preserve",
  preservesUnknownParts: true,
  usage: "request_and_model_usage_when_reported",
} as const satisfies ProviderToolResultNormalizerMetadata);
function descriptor<
  const TProvider extends ProviderToolVendor,
  const TKind extends ProviderToolKind,
>(
  value: Omit<ProviderToolDescriptor<TProvider, TKind>, "id" | "modelSupport" | "resultNormalizer">,
): ProviderToolDescriptor<TProvider, TKind> {
  return Object.freeze({
    ...value,
    id: `${value.provider}:${value.kind}`,
    modelSupport: "installed_metadata_exact",
    auth: Object.freeze([...value.auth]),
    dataAccess: Object.freeze([...value.dataAccess]),
    sandbox: Object.freeze([...value.sandbox]),
    resultNormalizer: normalizer,
  });
}
const hostedAuth = ["provider_account"] as const;
const hostedSandbox = ["provider_hosted"] as const;
const isolatedCompute = ["isolated_compute_required"] as const;
const workspace = ["workspace_required"] as const;

export const providerToolDescriptors = Object.freeze([
  descriptor({
    provider: "openai",
    kind: "web_search",
    category: "network.search",
    execution: "provider_hosted",
    auth: hostedAuth,
    cost: "provider_metered",
    dataAccess: ["public_network"],
    sideEffect: "external_read",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "openai",
    kind: "web_search_preview",
    category: "network.search",
    execution: "provider_hosted",
    auth: hostedAuth,
    cost: "provider_metered",
    dataAccess: ["public_network"],
    sideEffect: "external_read",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "openai",
    kind: "file_search",
    category: "data.provider_files.read",
    execution: "provider_hosted",
    auth: ["provider_account_resource_acl"],
    cost: "provider_metered",
    dataAccess: ["provider_files"],
    sideEffect: "external_read",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "openai",
    kind: "image_generation",
    category: "media.image.generate",
    execution: "provider_hosted",
    auth: hostedAuth,
    cost: "provider_metered_high_variance",
    dataAccess: ["provider_container"],
    sideEffect: "stateful_execution",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "openai",
    kind: "code_interpreter",
    category: "execution.hosted_code",
    execution: "provider_hosted",
    auth: hostedAuth,
    cost: "provider_metered_high_variance",
    dataAccess: ["provider_container"],
    sideEffect: "stateful_execution",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "openai",
    kind: "mcp",
    category: "integration.mcp.remote",
    execution: "hybrid",
    auth: ["provider_account_and_remote_credentials"],
    cost: "provider_metered",
    dataAccess: ["remote_integration"],
    sideEffect: "write",
    approval: "provider_interrupt",
    sandbox: ["remote_trust_boundary"],
  }),
  descriptor({
    provider: "openai",
    kind: "computer_use",
    category: "computer.control",
    execution: "caller_loop",
    auth: hostedAuth,
    cost: "provider_metered_high_variance",
    dataAccess: ["screen"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: ["isolated_desktop_required"],
  }),
  descriptor({
    provider: "openai",
    kind: "local_shell",
    category: "execution.shell",
    execution: "caller_loop",
    auth: hostedAuth,
    cost: "provider_metered_high_variance",
    dataAccess: ["workspace_files"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: isolatedCompute,
  }),
  descriptor({
    provider: "openai",
    kind: "shell",
    category: "execution.shell",
    execution: "caller_loop",
    auth: hostedAuth,
    cost: "provider_metered_high_variance",
    dataAccess: ["provider_container"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: isolatedCompute,
  }),
  descriptor({
    provider: "openai",
    kind: "apply_patch",
    category: "filesystem.write",
    execution: "caller_loop",
    auth: hostedAuth,
    cost: "provider_metered",
    dataAccess: ["workspace_files"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: workspace,
  }),
  descriptor({
    provider: "openai",
    kind: "custom",
    category: "provider.custom",
    execution: "caller_loop",
    auth: hostedAuth,
    cost: "provider_metered_high_variance",
    dataAccess: ["application_defined"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: isolatedCompute,
  }),
  descriptor({
    provider: "anthropic",
    kind: "web_search",
    category: "network.search",
    execution: "provider_hosted",
    auth: hostedAuth,
    cost: "provider_metered",
    dataAccess: ["public_network"],
    sideEffect: "external_read",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "anthropic",
    kind: "web_fetch",
    category: "network.fetch",
    execution: "provider_hosted",
    auth: hostedAuth,
    cost: "provider_metered",
    dataAccess: ["public_network"],
    sideEffect: "external_read",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "anthropic",
    kind: "code_execution",
    category: "execution.hosted_code",
    execution: "provider_hosted",
    auth: ["provider_account_beta_entitlement"],
    cost: "provider_metered_high_variance",
    dataAccess: ["provider_container"],
    sideEffect: "stateful_execution",
    approval: "run_optional",
    sandbox: hostedSandbox,
  }),
  descriptor({
    provider: "anthropic",
    kind: "computer_use",
    category: "computer.control",
    execution: "caller_loop",
    auth: ["provider_account_beta_entitlement"],
    cost: "provider_metered_high_variance",
    dataAccess: ["screen"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: ["isolated_desktop_required"],
  }),
  descriptor({
    provider: "anthropic",
    kind: "bash",
    category: "execution.shell",
    execution: "caller_loop",
    auth: ["provider_account_beta_entitlement"],
    cost: "provider_metered_high_variance",
    dataAccess: ["workspace_files"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: isolatedCompute,
  }),
  descriptor({
    provider: "anthropic",
    kind: "text_editor",
    category: "filesystem.write",
    execution: "caller_loop",
    auth: ["provider_account_beta_entitlement"],
    cost: "provider_metered",
    dataAccess: ["workspace_files"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: workspace,
  }),
  descriptor({
    provider: "anthropic",
    kind: "memory",
    category: "memory.read_write",
    execution: "caller_loop",
    auth: ["provider_account_beta_entitlement"],
    cost: "provider_metered",
    dataAccess: ["application_memory"],
    sideEffect: "write",
    approval: "action_required",
    sandbox: ["principal_storage_required"],
  }),
] as const);

export class UnknownProviderTool extends Schema.TaggedError<UnknownProviderTool>()(
  "UnknownProviderTool",
  { id: Schema.String },
) {}
export class UnknownProviderToolModel extends Schema.TaggedError<UnknownProviderToolModel>()(
  "UnknownProviderToolModel",
  { provider: ProviderVendor, model: Schema.String },
) {}
/** The descriptor or model tables contradict themselves; a programming error in the tables. */
export const ProviderToolMetadataFailureReason = Schema.TaggedUnion({
  /** A descriptor id is not `<provider>:<kind>`. */
  InvalidId: { id: Schema.String },
  DuplicateTool: { id: Schema.String },
  DuplicateModel: { provider: ProviderVendor, model: Schema.String },
});
export class ProviderToolMetadataFailure extends Schema.TaggedError<ProviderToolMetadataFailure>()(
  "ProviderToolMetadataFailure",
  { reason: ProviderToolMetadataFailureReason },
) {}
export interface ProviderToolModelMetadata {
  readonly provider: ProviderToolVendor;
  readonly model: string;
  readonly tools: readonly string[];
}
export interface ProviderToolFilter {
  readonly provider?: ProviderToolVendor;
  readonly categories?: readonly ProviderToolCategory[];
  readonly ids?: readonly ProviderToolId[];
}
export interface ProviderToolCapabilityQuery extends ProviderToolFilter {
  readonly provider: ProviderToolVendor;
  readonly model: string;
  readonly accountToolKinds?: readonly string[];
}
export interface ProviderToolCapabilityRegistryApi {
  readonly descriptors: readonly AnyProviderToolDescriptor[];
  readonly get: (id: string) => Effect.Effect<AnyProviderToolDescriptor, UnknownProviderTool>;
  readonly filter: (filter?: ProviderToolFilter) => readonly AnyProviderToolDescriptor[];
  readonly resolve: (
    query: ProviderToolCapabilityQuery,
  ) => Effect.Effect<readonly AnyProviderToolDescriptor[], UnknownProviderToolModel>;
}
const compareDescriptor = (left: AnyProviderToolDescriptor, right: AnyProviderToolDescriptor) =>
  left.id.localeCompare(right.id);
export const filterProviderTools: {
  (): (descriptors: readonly AnyProviderToolDescriptor[]) => readonly AnyProviderToolDescriptor[];
  (
    filter: ProviderToolFilter | undefined,
  ): (descriptors: readonly AnyProviderToolDescriptor[]) => readonly AnyProviderToolDescriptor[];
  (descriptors: readonly AnyProviderToolDescriptor[]): readonly AnyProviderToolDescriptor[];
  (
    descriptors: readonly AnyProviderToolDescriptor[],
    filter: ProviderToolFilter | undefined,
  ): readonly AnyProviderToolDescriptor[];
} = EffectFunction.dual((args) => EffectArray.isArray(args[0]), filterProviderToolsBody);
function filterProviderToolsBody(
  descriptors: readonly AnyProviderToolDescriptor[],
  filter: ProviderToolFilter = {},
): readonly AnyProviderToolDescriptor[] {
  const categories =
    filter.categories === undefined ? null : HashSet.fromIterable(filter.categories);
  const ids = filter.ids === undefined ? null : HashSet.fromIterable(filter.ids);
  return descriptors
    .filter(
      (entry) =>
        (filter.provider === undefined || entry.provider === filter.provider) &&
        (categories === null || HashSet.has(categories, entry.category)) &&
        (ids === null || HashSet.has(ids, entry.id)),
    )
    .toSorted(compareDescriptor);
}
/** Runtime model names and exact capability tuples are checked against adapter type metadata. */
export const installedProviderToolModelMetadata: readonly ProviderToolModelMetadata[] =
  Object.freeze([
    ...OPENAI_CHAT_MODELS.map((model) => ({
      provider: "openai" as const,
      model,
      tools: openAIModelToolCapabilities[model],
    })),
    ...ANTHROPIC_MODELS.map((model) => ({
      provider: "anthropic" as const,
      model,
      tools: anthropicModelToolCapabilities[model],
    })),
  ]);

function installedModelMetadata(): readonly ProviderToolModelMetadata[] {
  return installedProviderToolModelMetadata;
}
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function makeProviderToolCapabilityRegistry(
  options: {
    readonly descriptors?: readonly AnyProviderToolDescriptor[] | undefined;
    readonly models?: readonly ProviderToolModelMetadata[] | undefined;
  } = {},
) {
  return makeProviderToolCapabilityRegistryBody(options.descriptors, options.models);
}
function makeProviderToolCapabilityRegistryBody(
  descriptors: readonly AnyProviderToolDescriptor[] = providerToolDescriptors,
  models: readonly ProviderToolModelMetadata[] = installedModelMetadata(),
): Effect.Effect<ProviderToolCapabilityRegistryApi, ProviderToolMetadataFailure> {
  const metadataFailure = (reason: typeof ProviderToolMetadataFailureReason.Type) =>
    ProviderToolMetadataFailure.make({ reason });
  return Effect.gen(function* () {
    const byId = yield* Effect.reduce(
      descriptors,
      () => HashMap.empty<string, AnyProviderToolDescriptor>(),
      (known, entry) =>
        Effect.succeed(entry).pipe(
          Effect.filterOrFail(
            ({ id, provider, kind }) => id === `${provider}:${kind}`,
            ({ id }) =>
              metadataFailure(ProviderToolMetadataFailureReason.cases.InvalidId.make({ id })),
          ),
          Effect.filterOrFail(
            ({ id }) => !HashMap.has(known, id),
            ({ id }) =>
              metadataFailure(ProviderToolMetadataFailureReason.cases.DuplicateTool.make({ id })),
          ),
          Effect.map((valid) => HashMap.set(known, valid.id, valid)),
        ),
    );
    const byModel = yield* Effect.reduce(
      models,
      () => HashMap.empty<string, HashSet.HashSet<string>>(),
      (known, model) =>
        Effect.succeed(`${model.provider}:${model.model}`).pipe(
          Effect.filterOrFail(
            (key) => !HashMap.has(known, key),
            () =>
              metadataFailure(
                ProviderToolMetadataFailureReason.cases.DuplicateModel.make({
                  provider: model.provider,
                  model: model.model,
                }),
              ),
          ),
          Effect.map((key) => HashMap.set(known, key, HashSet.fromIterable(model.tools))),
        ),
    );
    const stableDescriptors = Object.freeze([...descriptors].toSorted(compareDescriptor));
    return {
      descriptors: stableDescriptors,
      get: (id) => Effect.fromOption(HashMap.get(byId, id), () => UnknownProviderTool.make({ id })),
      filter: (query) => filterProviderTools(stableDescriptors, query),
      resolve: (query) =>
        Effect.map(
          Effect.fromOption(HashMap.get(byModel, `${query.provider}:${query.model}`), () =>
            UnknownProviderToolModel.make({ provider: query.provider, model: query.model }),
          ),
          (supported) => {
            const account = Option.map(
              Option.fromNullishOr(query.accountToolKinds),
              HashSet.fromIterable,
            );
            return filterProviderTools(stableDescriptors, query).filter(
              (entry) =>
                HashSet.has(supported, entry.kind) &&
                Option.match(account, {
                  onNone: () => true,
                  onSome: (kinds) => HashSet.has(kinds, entry.kind),
                }),
            );
          },
        ),
    };
  });
}
export class ProviderToolCapabilityRegistry extends Context.Service<
  ProviderToolCapabilityRegistry,
  ProviderToolCapabilityRegistryApi
>()("memory-agent/providers/tool-capabilities/ProviderToolCapabilityRegistry") {
  static readonly layer = Layer.effect(
    ProviderToolCapabilityRegistry,
    makeProviderToolCapabilityRegistry({}),
  );
  static readonly layerFrom = (
    descriptors: readonly AnyProviderToolDescriptor[],
    models?: readonly ProviderToolModelMetadata[],
  ) =>
    Layer.effect(
      ProviderToolCapabilityRegistry,
      makeProviderToolCapabilityRegistry({ descriptors: descriptors, models: models }),
    );
}
export type InstalledProviderToolModel = OpenAIChatModel | AnthropicChatModel;
