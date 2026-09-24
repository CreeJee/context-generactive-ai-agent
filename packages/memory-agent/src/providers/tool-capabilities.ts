import { ANTHROPIC_MODELS, type AnthropicChatModel } from "@tanstack/ai-anthropic";
import * as AnthropicTools from "@tanstack/ai-anthropic/tools";
import { OPENAI_CHAT_MODELS, type OpenAIChatModel } from "@tanstack/ai-openai";
import * as OpenAITools from "@tanstack/ai-openai/tools";
import { Context, Data, Effect, Layer } from "effect";
import {
  anthropicModelToolCapabilities,
  openAIModelToolCapabilities,
} from "./model-tool-capabilities.ts";

export type ProviderToolProvider = "openai" | "anthropic";
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
export type OpenAIProviderToolKind =
  | "web_search"
  | "web_search_preview"
  | "file_search"
  | "image_generation"
  | "code_interpreter"
  | "mcp"
  | "computer_use"
  | "local_shell"
  | "shell"
  | "apply_patch"
  | "custom";
export type AnthropicProviderToolKind =
  | "web_search"
  | "web_fetch"
  | "code_execution"
  | "computer_use"
  | "bash"
  | "text_editor"
  | "memory";
export type ProviderToolKind = OpenAIProviderToolKind | AnthropicProviderToolKind;
export type ProviderToolId =
  | `openai:${OpenAIProviderToolKind}`
  | `anthropic:${AnthropicProviderToolKind}`;

export interface ProviderToolFactoryExtension<TFactory extends (...args: never[]) => object> {
  readonly factory: TFactory;
}
export interface ProviderToolResultNormalizerMetadata {
  readonly strategy: "provider_native_preserve";
  readonly preservesUnknownParts: true;
  readonly usage: "request_and_model_usage_when_reported";
}
export interface ProviderToolDescriptor<
  TProvider extends ProviderToolProvider = ProviderToolProvider,
  TKind extends ProviderToolKind = ProviderToolKind,
  TFactory extends (...args: never[]) => object = (...args: never[]) => object,
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
  readonly extension: ProviderToolFactoryExtension<TFactory>;
  readonly resultNormalizer: ProviderToolResultNormalizerMetadata;
}
export type AnyProviderToolDescriptor =
  | ProviderToolDescriptor<"openai", OpenAIProviderToolKind, (...args: never[]) => object>
  | ProviderToolDescriptor<"anthropic", AnthropicProviderToolKind, (...args: never[]) => object>;

const normalizer = Object.freeze({
  strategy: "provider_native_preserve",
  preservesUnknownParts: true,
  usage: "request_and_model_usage_when_reported",
} as const satisfies ProviderToolResultNormalizerMetadata);
function descriptor<
  const TProvider extends ProviderToolProvider,
  const TKind extends ProviderToolKind,
  TFactory extends (...args: never[]) => object,
>(
  value: Omit<
    ProviderToolDescriptor<TProvider, TKind, TFactory>,
    "id" | "modelSupport" | "resultNormalizer"
  >,
): ProviderToolDescriptor<TProvider, TKind, TFactory> {
  return Object.freeze({
    ...value,
    id: `${value.provider}:${value.kind}`,
    modelSupport: "installed_metadata_exact",
    auth: Object.freeze([...value.auth]),
    dataAccess: Object.freeze([...value.dataAccess]),
    sandbox: Object.freeze([...value.sandbox]),
    extension: Object.freeze(value.extension),
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
    extension: { factory: OpenAITools.webSearchTool },
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
    extension: { factory: OpenAITools.webSearchPreviewTool },
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
    extension: { factory: OpenAITools.fileSearchTool },
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
    extension: { factory: OpenAITools.imageGenerationTool },
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
    extension: { factory: OpenAITools.codeInterpreterTool },
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
    extension: { factory: OpenAITools.mcpTool },
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
    extension: { factory: OpenAITools.computerUseTool },
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
    extension: { factory: OpenAITools.localShellTool },
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
    extension: { factory: OpenAITools.shellTool },
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
    extension: { factory: OpenAITools.applyPatchTool },
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
    extension: { factory: OpenAITools.customTool },
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
    extension: { factory: AnthropicTools.webSearchTool },
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
    extension: { factory: AnthropicTools.webFetchTool },
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
    extension: { factory: AnthropicTools.codeExecutionTool },
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
    extension: { factory: AnthropicTools.computerUseTool },
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
    extension: { factory: AnthropicTools.bashTool },
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
    extension: { factory: AnthropicTools.textEditorTool },
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
    extension: { factory: AnthropicTools.memoryTool },
  }),
] as const);

export class UnknownProviderTool extends Data.TaggedError("UnknownProviderTool")<{
  readonly id: string;
}> {}
export class UnknownProviderToolModel extends Data.TaggedError("UnknownProviderToolModel")<{
  readonly provider: ProviderToolProvider;
  readonly model: string;
}> {}
export class ProviderToolMetadataFailure extends Data.TaggedError("ProviderToolMetadataFailure")<{
  readonly reason: string;
}> {}
export interface ProviderToolModelMetadata {
  readonly provider: ProviderToolProvider;
  readonly model: string;
  readonly tools: readonly string[];
}
export interface ProviderToolFilter {
  readonly provider?: ProviderToolProvider;
  readonly categories?: readonly ProviderToolCategory[];
  readonly ids?: readonly ProviderToolId[];
}
export interface ProviderToolCapabilityQuery extends ProviderToolFilter {
  readonly provider: ProviderToolProvider;
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
export function filterProviderTools(
  descriptors: readonly AnyProviderToolDescriptor[],
  filter: ProviderToolFilter = {},
): readonly AnyProviderToolDescriptor[] {
  const categories = filter.categories === undefined ? null : new Set(filter.categories);
  const ids = filter.ids === undefined ? null : new Set(filter.ids);
  return descriptors
    .filter(
      (entry) =>
        (filter.provider === undefined || entry.provider === filter.provider) &&
        (categories === null || categories.has(entry.category)) &&
        (ids === null || ids.has(entry.id)),
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
export function makeProviderToolCapabilityRegistry(
  descriptors: readonly AnyProviderToolDescriptor[] = providerToolDescriptors,
  models: readonly ProviderToolModelMetadata[] = installedModelMetadata(),
): Effect.Effect<ProviderToolCapabilityRegistryApi, ProviderToolMetadataFailure> {
  return Effect.gen(function* () {
    const byId = new Map<string, AnyProviderToolDescriptor>();
    for (const entry of descriptors) {
      if (entry.id !== `${entry.provider}:${entry.kind}`)
        return yield* new ProviderToolMetadataFailure({
          reason: `invalid provider-qualified id: ${entry.id}`,
        });
      if (byId.has(entry.id))
        return yield* new ProviderToolMetadataFailure({
          reason: `duplicate provider tool id: ${entry.id}`,
        });
      byId.set(entry.id, entry);
    }
    const byModel = new Map<string, ReadonlySet<string>>();
    for (const model of models) {
      const key = `${model.provider}:${model.model}`;
      if (byModel.has(key))
        return yield* new ProviderToolMetadataFailure({
          reason: `duplicate provider model metadata: ${key}`,
        });
      byModel.set(key, new Set(model.tools));
    }
    const stableDescriptors = Object.freeze([...descriptors].toSorted(compareDescriptor));
    return {
      descriptors: stableDescriptors,
      get: (id) => {
        const found = byId.get(id);
        return found === undefined
          ? Effect.fail(new UnknownProviderTool({ id }))
          : Effect.succeed(found);
      },
      filter: (query) => filterProviderTools(stableDescriptors, query),
      resolve: (query) => {
        const supported = byModel.get(`${query.provider}:${query.model}`);
        if (supported === undefined)
          return Effect.fail(
            new UnknownProviderToolModel({ provider: query.provider, model: query.model }),
          );
        const account =
          query.accountToolKinds === undefined ? null : new Set(query.accountToolKinds);
        return Effect.succeed(
          filterProviderTools(stableDescriptors, query).filter(
            (entry) => supported.has(entry.kind) && (account === null || account.has(entry.kind)),
          ),
        );
      },
    };
  });
}
export class ProviderToolCapabilityRegistry extends Context.Service<
  ProviderToolCapabilityRegistry,
  ProviderToolCapabilityRegistryApi
>()("memory-agent/ProviderToolCapabilityRegistry") {
  static readonly layer = Layer.effect(
    ProviderToolCapabilityRegistry,
    makeProviderToolCapabilityRegistry(),
  );
  static readonly layerFrom = (
    descriptors: readonly AnyProviderToolDescriptor[],
    models?: readonly ProviderToolModelMetadata[],
  ) =>
    Layer.effect(
      ProviderToolCapabilityRegistry,
      makeProviderToolCapabilityRegistry(descriptors, models),
    );
}
export type InstalledProviderToolModel = OpenAIChatModel | AnthropicChatModel;
