import type { GlobalConfigFailed } from "../config/global-config.ts";
import { Data, Effect, Schema, type Scope } from "effect";
import type { AiError, LanguageModel } from "effect/ai";
import type { MessageSource } from "../chat-store/schema.ts";

/** Persisted model connection ID. Compatible endpoints are not an OpenAI vendor identity. */
export const ProviderId = Schema.Literals(["openai", "anthropic", "openai-compatible"]);
export type ProviderId = typeof ProviderId.Type;

/** Vendor namespaces for account protocols and native tool schemas. */
export const ProviderVendor = Schema.Literals(["openai", "anthropic"]);
export type ProviderVendor = typeof ProviderVendor.Type;

/** Account providers supported by the subscription OAuth implementation. */
export const SubscriptionAccountProvider = ProviderVendor;
export type SubscriptionAccountProvider = typeof SubscriptionAccountProvider.Type;

export const NativeToolSupport = Schema.TaggedUnion({
  "vendor-native": { vendor: ProviderVendor },
  unsupported: {},
});
export type NativeToolSupport = typeof NativeToolSupport.Type;

export const ProviderConnection = Schema.TaggedUnion({
  subscription: {
    accountProvider: SubscriptionAccountProvider,
    nativeTools: NativeToolSupport,
  },
  "compatible-endpoint": {
    protocol: Schema.Literal("openai-chat-completions"),
    nativeTools: NativeToolSupport,
  },
});
export type ProviderConnection = typeof ProviderConnection.Type;

const subscriptionConnection = (vendor: ProviderVendor): ProviderConnection =>
  ProviderConnection.cases.subscription.make({
    accountProvider: vendor,
    nativeTools: NativeToolSupport.cases["vendor-native"].make({ vendor }),
  });
const connections = {
  openai: subscriptionConnection("openai"),
  anthropic: subscriptionConnection("anthropic"),
  "openai-compatible": ProviderConnection.cases["compatible-endpoint"].make({
    protocol: "openai-chat-completions",
    nativeTools: NativeToolSupport.cases.unsupported.make({}),
  }),
} satisfies Record<ProviderId, ProviderConnection>;

/** Resolve persisted IDs once; consumers dispatch on connection kind and tool support. */
export function providerConnection(provider: ProviderId): ProviderConnection {
  return connections[provider];
}

/** A model is never identified without its provider. */
export const ModelSelection = Schema.Struct({
  provider: ProviderId,
  model: Schema.String,
  reasoningEffort: Schema.String,
});
export type ModelSelection = typeof ModelSelection.Type;

export const SubscriptionModelSelection = Schema.Struct({
  ...ModelSelection.fields,
  provider: SubscriptionAccountProvider,
});
export type SubscriptionModelSelection = typeof SubscriptionModelSelection.Type;

export const ModelCapabilities = Schema.Struct({
  inputModalities: Schema.Array(Schema.Literals(["text", "image"])),
  toolCalling: Schema.Boolean,
  reasoning: Schema.Boolean,
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const ProviderModel = Schema.Struct({
  provider: ProviderId,
  id: Schema.String,
  displayName: Schema.String,
  isDefault: Schema.Boolean,
  defaultReasoningEffort: Schema.String,
  supportedReasoningEfforts: Schema.Array(Schema.String),
  /** Model-advertised input context size, when the provider catalog supplies one. */
  contextWindow: Schema.optional(Schema.Finite),
  capabilities: ModelCapabilities,
});
export type ProviderModel = typeof ProviderModel.Type;

/** The user's image-generation preference (`image-feature.ts`). */
export const ImageFeatureStatus = Schema.Struct({ imageGenerationEnabled: Schema.Boolean });
export type ImageFeatureStatus = typeof ImageFeatureStatus.Type;

export class ProviderUnavailable extends Schema.TaggedError<
  ProviderUnavailable,
  { readonly brand: unique symbol }
>()("ProviderUnavailable", { provider: ProviderId }) {}

export class ModelUnavailable extends Schema.TaggedError<
  ModelUnavailable,
  { readonly brand: unique symbol }
>()("ModelUnavailable", {
  provider: ProviderId,
  model: Schema.String,
  reasoningEffort: Schema.optionalKey(Schema.String),
}) {}

export class ProviderOperationFailed extends Schema.TaggedError<
  ProviderOperationFailed,
  { readonly brand: unique symbol }
>()("ProviderOperationFailed", {
  provider: ProviderId,
  operation: Schema.Literals(["auth", "catalog", "model"]),
}) {}

type AuthConnectionCases = {
  readonly "signed-out": { readonly provider: ProviderId };
  readonly pending: { readonly provider: ProviderId; readonly authorizationUrl: string };
  readonly "signed-in": { readonly provider: ProviderId; readonly planType?: string };
  readonly error: {
    readonly provider: ProviderId;
    readonly message: string;
    readonly code?: string;
    readonly operation?: string;
    readonly httpStatus?: number;
    readonly providerCode?: string;
    readonly credentialStage?: string;
    readonly transportCode?: string;
    readonly proxyRoute?: "direct" | "unavailable" | "attempted";
  };
};
/** A provider's account connection, in the case its login is in. */
export type AuthConnectionState = Data.TaggedEnum<AuthConnectionCases>;
export const AuthConnectionState = Data.taggedEnum<AuthConnectionState>();
/** The case an `AuthConnectionState` is in. */
export type AuthStatus = keyof AuthConnectionCases;

/** Authentication lifecycle only. Deliberately has no token or credential getter. */
export interface AuthProvider {
  readonly provider: ProviderId;
  readonly status: Effect.Effect<AuthConnectionState, ProviderOperationFailed>;
  readonly connect: Effect.Effect<AuthConnectionState, ProviderOperationFailed>;
  readonly cancel: Effect.Effect<AuthConnectionState, ProviderOperationFailed>;
  readonly disconnect: Effect.Effect<AuthConnectionState, ProviderOperationFailed>;
}

export interface ModelCatalog {
  readonly provider: ProviderId;
  readonly list: Effect.Effect<ReadonlyArray<ProviderModel>, ProviderOperationFailed>;
  readonly selected: Effect.Effect<ModelSelection | null, GlobalConfigFailed>;
  readonly acceptsImages: (model: string) => Effect.Effect<boolean, ProviderOperationFailed>;
  readonly cheapestEffort: (selection: ModelSelection) => Effect.Effect<ModelSelection>;
  readonly select: (
    model: string,
    reasoningEffort?: string,
  ) => Effect.Effect<ModelSelection, ModelUnavailable | ProviderOperationFailed>;
}

/** How long the provider keeps a run's request prefix cached. */
export const CacheRetention = Schema.Literals(["none", "short", "long"]);
export type CacheRetention = typeof CacheRetention.Type;

/**
 * The run a model is made for. The loop makes one model per run, so the model knows the run it
 * answers: its prompt cache is keyed by the thread.
 */
export interface ModelRun {
  readonly threadId: string;
  readonly runId: string;
  readonly cacheRetention: CacheRetention;
}

/**
 * A failed model call as the user sees it: the app's words, never the provider's text. The page
 * words `code` when there is one.
 */
export interface ShownFailure {
  readonly message: string;
  readonly code?: string;
}

/** One run's model on Effect AI, with what the run writes about it. */
export interface RunModel {
  readonly model: LanguageModel.LanguageModel;
  /** Written on every message the model writes; replay compares it with the model it sends to. */
  readonly source: typeof MessageSource.Type;
  readonly shownFailure: (error: AiError.AiError) => ShownFailure;
  /** Pinned connection identity for detecting a server change without retaining credentials. */
  readonly historyKey?: string;
}

export interface AgentModelRuntime {
  readonly provider: ProviderId;
  /**
   * The run's model on Effect AI. What it pins for the run, such as an account, is let go when
   * the scope closes.
   */
  readonly model: (
    selection: ModelSelection,
    run: ModelRun,
  ) => Effect.Effect<RunModel, ModelUnavailable, Scope.Scope>;
  readonly contextWindow: (model: string) => number;
  /** False when contextWindow is only a conservative fallback, not model metadata. */
  readonly contextWindowKnown?: (model: string) => boolean;
}

export interface ProviderConfiguration {
  readonly provider: ProviderId;
  readonly auth: AuthProvider;
  readonly models: ModelCatalog;
}

export interface ProviderServices extends ProviderConfiguration {
  readonly runtime: AgentModelRuntime;
}
