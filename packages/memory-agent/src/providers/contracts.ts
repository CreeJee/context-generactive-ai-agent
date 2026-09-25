import type { AgentLoopStrategy, AnyTextAdapter, ChatMiddleware, ModelMessage } from "@tanstack/ai";
import { Data, Effect, Schema } from "effect";

/** Subscription providers supported by the product runtime. */
export const ProviderId = Schema.Literals(["openai", "anthropic"]);
export type ProviderId = typeof ProviderId.Type;

/** A model is never identified without its provider. */
export const ModelSelection = Schema.Struct({
  provider: ProviderId,
  model: Schema.String,
  reasoningEffort: Schema.String,
});
export type ModelSelection = typeof ModelSelection.Type;

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
  contextWindow: Schema.optional(Schema.Number),
  capabilities: ModelCapabilities,
});
export type ProviderModel = typeof ProviderModel.Type;

export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly provider: ProviderId;
}> {}

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly provider: ProviderId;
  readonly model: string;
  readonly reasoningEffort?: string;
}> {}

export class ProviderOperationFailed extends Data.TaggedError("ProviderOperationFailed")<{
  readonly provider: ProviderId;
  readonly operation: "auth" | "catalog" | "model";
}> {}

export type AuthConnectionState =
  | { readonly provider: ProviderId; readonly status: "signed-out" }
  | {
      readonly provider: ProviderId;
      readonly status: "pending";
      readonly authorizationUrl: string;
    }
  | {
      readonly provider: ProviderId;
      readonly status: "signed-in";
      readonly planType?: string;
    }
  | {
      readonly provider: ProviderId;
      readonly status: "error";
      readonly message: string;
      readonly code?: string;
      readonly operation?: string;
      readonly httpStatus?: number;
      readonly providerCode?: string;
      readonly credentialStage?: string;
      readonly transportCode?: string;
    };

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
  readonly selected: Effect.Effect<ModelSelection | null>;
  readonly acceptsImages: (model: string) => Effect.Effect<boolean, ProviderOperationFailed>;
  readonly cheapestEffort: (selection: ModelSelection) => Effect.Effect<ModelSelection>;
  readonly select: (
    model: string,
    reasoningEffort?: string,
  ) => Effect.Effect<ModelSelection, ModelUnavailable | ProviderOperationFailed>;
}

/** Provider-native transport behind the provider-neutral orchestration boundary. */
export interface AgentModelRuntime {
  readonly provider: ProviderId;
  readonly adapter: (selection: ModelSelection) => AnyTextAdapter;
  readonly contextWindow: (model: string) => number;
  /** False when contextWindow is only a conservative fallback, not model metadata. */
  readonly contextWindowKnown?: (model: string) => boolean;
  readonly agentLoop: AgentLoopStrategy;
  readonly runMiddleware: () => ChatMiddleware;
  readonly steer: (threadId: string, message: ModelMessage) => Promise<"steered" | "no_turn">;
}

export interface ProviderConfiguration {
  readonly provider: ProviderId;
  readonly auth: AuthProvider;
  readonly models: ModelCatalog;
}

export interface ProviderServices extends ProviderConfiguration {
  readonly runtime: AgentModelRuntime;
}
