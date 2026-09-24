import { Context, Data, Effect, Layer, Ref } from "effect";
import type { AuthConnectionState, ProviderId, ProviderModel } from "./contracts.ts";
import type { ImageRouteContract } from "./image-contracts.ts";
import { imageRouteContracts } from "./image-contracts.ts";
import { ProviderRegistry } from "./registry.ts";
import {
  ProviderToolCapabilityRegistry,
  type ProviderToolAuth,
  type ProviderToolCategory,
  type ProviderToolCost,
  type ProviderToolId,
} from "./tool-capabilities.ts";

export type RouteEvidenceStatus = "verified" | "unverified" | "unsupported";

export interface RouteAuthEvidence {
  readonly mechanism: "subscription_oauth" | "openai_api_key";
  readonly status: AuthConnectionState["status"];
  readonly planType?: string;
  readonly verified: boolean;
}

export interface RouteEntitlementEvidence {
  readonly status: RouteEvidenceStatus;
  readonly source:
    | "provider_model_catalog"
    | "installed_model_metadata"
    | "account_capability"
    | "account_smoke_test_not_run";
  readonly detail: string;
}

export interface ChatRoute {
  readonly type: "chat";
  readonly id: `chat:${ProviderId}:${string}`;
  readonly provider: ProviderId;
  readonly model: string;
  readonly displayName: string;
  readonly capabilities: ProviderModel["capabilities"];
  readonly reasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string;
  readonly authentication: RouteAuthEvidence;
  readonly entitlement: RouteEntitlementEvidence;
}

export interface MediaRoute {
  readonly type: "media";
  readonly id: `media:${string}`;
  readonly provider: "openai";
  readonly executionMode: ImageRouteContract["executionMode"];
  readonly executorModel: ImageRouteContract["executorModel"];
  readonly operations: ImageRouteContract["operations"];
  readonly authentication: RouteAuthEvidence;
  readonly entitlement: RouteEntitlementEvidence;
  readonly billingAttribution: ImageRouteContract["billingAttribution"];
  readonly contract: ImageRouteContract;
}

export interface ExecutionRoute {
  readonly type: "execution";
  readonly id: `execution:${ProviderId}:${string}:${ProviderToolId}`;
  readonly provider: ProviderId;
  readonly model: string;
  readonly toolId: ProviderToolId;
  readonly category: ProviderToolCategory;
  readonly authentication: RouteAuthEvidence;
  readonly entitlement: RouteEntitlementEvidence;
  readonly requiredAuth: readonly ProviderToolAuth[];
  readonly cost: ProviderToolCost;
}

export interface ChatMediaRoutePair {
  readonly initiatorChatRouteId: ChatRoute["id"];
  readonly executorMediaRouteId: MediaRoute["id"];
  readonly initiatorChatProvider: ProviderId;
  readonly executorMediaProvider: "openai";
  readonly crossProvider: boolean;
}

export interface RouteCatalogSnapshot {
  readonly revision: number;
  readonly refreshedAt: number;
  readonly chat: readonly ChatRoute[];
  readonly media: readonly MediaRoute[];
  readonly execution: readonly ExecutionRoute[];
}

export class RouteCatalogRefreshFailed extends Data.TaggedError("RouteCatalogRefreshFailed")<{
  readonly provider?: ProviderId;
  readonly operation: "provider" | "auth" | "models" | "tools";
  readonly cause: unknown;
}> {}

export class UnknownCatalogRoute extends Data.TaggedError("UnknownCatalogRoute")<{
  readonly routeType: "chat" | "media" | "execution";
  readonly id: string;
}> {}

export class IncompatibleCatalogRoutes extends Data.TaggedError("IncompatibleCatalogRoutes")<{
  readonly chatRouteId: string;
  readonly mediaRouteId: string;
  readonly reason: string;
}> {}

export interface RouteCatalogApi {
  readonly snapshot: Effect.Effect<RouteCatalogSnapshot>;
  readonly refresh: Effect.Effect<RouteCatalogSnapshot, RouteCatalogRefreshFailed>;
  readonly chat: (id: ChatRoute["id"]) => Effect.Effect<ChatRoute, UnknownCatalogRoute>;
  readonly media: (id: MediaRoute["id"]) => Effect.Effect<MediaRoute, UnknownCatalogRoute>;
  readonly execution: (
    id: ExecutionRoute["id"],
  ) => Effect.Effect<ExecutionRoute, UnknownCatalogRoute>;
  readonly pairChatWithMedia: (
    chatRouteId: ChatRoute["id"],
    mediaRouteId: MediaRoute["id"],
  ) => Effect.Effect<ChatMediaRoutePair, UnknownCatalogRoute | IncompatibleCatalogRoutes>;
}

export interface RouteCatalogSource {
  readonly load: Effect.Effect<
    Omit<RouteCatalogSnapshot, "revision" | "refreshedAt">,
    RouteCatalogRefreshFailed
  >;
}

const compareId = (left: { readonly id: string }, right: { readonly id: string }) =>
  left.id.localeCompare(right.id);

const freezeSnapshot = (snapshot: RouteCatalogSnapshot): RouteCatalogSnapshot =>
  Object.freeze({
    ...snapshot,
    chat: Object.freeze([...snapshot.chat].toSorted(compareId)),
    media: Object.freeze([...snapshot.media].toSorted(compareId)),
    execution: Object.freeze([...snapshot.execution].toSorted(compareId)),
  });

const authEvidence = (
  provider: ProviderId,
  status: AuthConnectionState,
  mechanism: RouteAuthEvidence["mechanism"],
): RouteAuthEvidence => {
  const evidence: RouteAuthEvidence = {
    mechanism,
    status: status.status,
    verified: status.status === "signed-in" && status.provider === provider,
  };
  return Object.freeze(
    status.status === "signed-in" && status.planType !== undefined
      ? { ...evidence, planType: status.planType }
      : evidence,
  );
};

const sourceFromServices = Effect.gen(function* () {
  const providers = yield* ProviderRegistry;
  const tools = yield* ProviderToolCapabilityRegistry;

  return {
    load: Effect.gen(function* () {
      const chat: ChatRoute[] = [];
      const media: MediaRoute[] = [];
      const execution: ExecutionRoute[] = [];
      const authByProvider = new Map<ProviderId, RouteAuthEvidence>();

      for (const provider of [...providers.providers].toSorted()) {
        const configuration = yield* providers
          .get(provider)
          .pipe(
            Effect.mapError(
              (cause) => new RouteCatalogRefreshFailed({ provider, operation: "provider", cause }),
            ),
          );
        const status = yield* configuration.auth.status.pipe(
          Effect.mapError(
            (cause) => new RouteCatalogRefreshFailed({ provider, operation: "auth", cause }),
          ),
        );
        const authentication = authEvidence(
          provider,
          status,
          provider === "openai" ? "openai_api_key" : "subscription_oauth",
        );
        authByProvider.set(provider, authentication);
        const models = yield* configuration.models.list.pipe(
          Effect.mapError(
            (cause) => new RouteCatalogRefreshFailed({ provider, operation: "models", cause }),
          ),
        );
        for (const model of models) {
          if (model.provider !== provider)
            return yield* new RouteCatalogRefreshFailed({
              provider,
              operation: "models",
              cause: new Error(`model provider mismatch: ${model.provider}:${model.id}`),
            });
          const chatRoute: ChatRoute = Object.freeze({
            type: "chat",
            id: `chat:${provider}:${model.id}`,
            provider,
            model: model.id,
            displayName: model.displayName,
            capabilities: model.capabilities,
            reasoningEfforts: Object.freeze([...model.supportedReasoningEfforts]),
            defaultReasoningEffort: model.defaultReasoningEffort,
            authentication,
            entitlement: Object.freeze({
              status: authentication.verified ? "verified" : "unverified",
              source: "provider_model_catalog",
              detail: "Model was returned by the configured provider catalog.",
            }),
          });
          chat.push(chatRoute);

          const resolved = yield* tools.resolve({ provider, model: model.id }).pipe(
            Effect.catchTag("UnknownProviderToolModel", () => Effect.succeed([])),
            Effect.mapError(
              (cause) => new RouteCatalogRefreshFailed({ provider, operation: "tools", cause }),
            ),
          );
          for (const descriptor of resolved) {
            execution.push(
              Object.freeze({
                type: "execution",
                id: `execution:${provider}:${model.id}:${descriptor.id}`,
                provider,
                model: model.id,
                toolId: descriptor.id,
                category: descriptor.category,
                authentication,
                entitlement: Object.freeze({
                  status: "unverified",
                  source: "installed_model_metadata",
                  detail:
                    "Installed metadata supports this tool; account entitlement remains unverified.",
                }),
                requiredAuth: Object.freeze([...descriptor.auth]),
                cost: descriptor.cost,
              }),
            );
          }
        }
      }

      const openAIAuth =
        authByProvider.get("openai") ??
        authEvidence("openai", { provider: "openai", status: "signed-out" }, "openai_api_key");
      for (const contract of imageRouteContracts) {
        const authentication =
          contract.executionMode === "direct_adapter"
            ? Object.freeze({
                mechanism: "openai_api_key" as const,
                status:
                  process.env.OPENAI_API_KEY === undefined
                    ? ("signed-out" as const)
                    : ("signed-in" as const),
                verified: process.env.OPENAI_API_KEY !== undefined,
              })
            : openAIAuth;
        media.push(
          Object.freeze({
            type: "media",
            id: `media:${contract.id}`,
            provider: contract.provider,
            executionMode: contract.executionMode,
            executorModel: contract.executorModel,
            operations: contract.operations,
            authentication,
            entitlement: Object.freeze({
              status: "unverified",
              source: "account_smoke_test_not_run",
              detail:
                "The execution path is implemented; account image access is validated by execution.",
            }),
            billingAttribution: contract.billingAttribution,
            contract,
          }),
        );
      }
      return {
        chat: chat.toSorted(compareId),
        media: media.toSorted(compareId),
        execution: execution.toSorted(compareId),
      };
    }),
  } satisfies RouteCatalogSource;
});

export function makeRouteCatalog(
  source: RouteCatalogSource,
  now: () => number = Date.now,
): Effect.Effect<RouteCatalogApi> {
  return Effect.gen(function* () {
    const state = yield* Ref.make<RouteCatalogSnapshot>(
      freezeSnapshot({ revision: 0, refreshedAt: 0, chat: [], media: [], execution: [] }),
    );
    const refresh = Effect.gen(function* () {
      const loaded = yield* source.load;
      const previous = yield* Ref.get(state);
      const next = freezeSnapshot({
        ...loaded,
        revision: previous.revision + 1,
        refreshedAt: now(),
      });
      yield* Ref.set(state, next);
      return next;
    });
    const find = <Route extends { readonly id: string }>(
      routeType: UnknownCatalogRoute["routeType"],
      routes: readonly Route[],
      id: string,
    ): Effect.Effect<Route, UnknownCatalogRoute> => {
      const route = routes.find((candidate) => candidate.id === id);
      return route === undefined
        ? Effect.fail(new UnknownCatalogRoute({ routeType, id }))
        : Effect.succeed(route);
    };
    return {
      snapshot: Ref.get(state),
      refresh,
      chat: (id) => Effect.flatMap(Ref.get(state), (snapshot) => find("chat", snapshot.chat, id)),
      media: (id) =>
        Effect.flatMap(Ref.get(state), (snapshot) => find("media", snapshot.media, id)),
      execution: (id) =>
        Effect.flatMap(Ref.get(state), (snapshot) => find("execution", snapshot.execution, id)),
      pairChatWithMedia: (chatRouteId, mediaRouteId) =>
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(state);
          const chatRoute = yield* find("chat", snapshot.chat, chatRouteId);
          const mediaRoute = yield* find("media", snapshot.media, mediaRouteId);
          if (!mediaRoute.operations.includes("generate"))
            return yield* new IncompatibleCatalogRoutes({
              chatRouteId,
              mediaRouteId,
              reason: "media route does not support image generation",
            });
          return Object.freeze({
            initiatorChatRouteId: chatRoute.id,
            executorMediaRouteId: mediaRoute.id,
            initiatorChatProvider: chatRoute.provider,
            executorMediaProvider: mediaRoute.provider,
            crossProvider: chatRoute.provider !== mediaRoute.provider,
          });
        }),
    };
  });
}

export class RouteCatalog extends Context.Service<RouteCatalog, RouteCatalogApi>()(
  "memory-agent/RouteCatalog",
) {
  static readonly layer = Layer.effect(
    RouteCatalog,
    Effect.flatMap(sourceFromServices, (source) => makeRouteCatalog(source)),
  );
  static readonly layerFrom = (source: RouteCatalogSource, now?: () => number) =>
    Layer.effect(RouteCatalog, makeRouteCatalog(source, now));
}
