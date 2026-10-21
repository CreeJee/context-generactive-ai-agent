import { providerConnection, type ProviderVendor } from "./contracts.ts";
import {
  Clock,
  Function as EffectFunction,
  Predicate,
  MutableHashMap,
  ConfigProvider,
  Option,
  Config,
  Context,
  Effect,
  Layer,
  Ref,
  Schema,
} from "effect";
import { ProviderId, type AuthConnectionState, type ProviderModel } from "./contracts.ts";
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
  readonly mechanism: "subscription_oauth" | "openai_api_key" | "openai_compatible";
  readonly status: AuthConnectionState["status"];
  readonly planType?: string;
  readonly verified: boolean;
}

export interface RouteEntitlementEvidence {
  readonly status: RouteEvidenceStatus;
  readonly source:
    | "provider_model_catalog"
    | "endpoint_configuration"
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
  readonly id: `execution:${ProviderVendor}:${string}:${ProviderToolId}`;
  readonly provider: ProviderVendor;
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

export const RouteCatalogRefreshFailedReason = Schema.TaggedUnion({
  /** The provider, its catalog or the environment failed; `cause` has its error. */
  Failed: {},
  /** A provider's catalog listed a model under another provider. */
  ProviderMismatch: {},
});

export class RouteCatalogRefreshFailed extends Schema.TaggedError<RouteCatalogRefreshFailed>()(
  "RouteCatalogRefreshFailed",
  {
    provider: Schema.optionalKey(ProviderId),
    operation: Schema.Literals(["provider", "auth", "models", "tools", "config"]),
    reason: RouteCatalogRefreshFailedReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class UnknownCatalogRoute extends Schema.TaggedError<UnknownCatalogRoute>()(
  "UnknownCatalogRoute",
  { routeType: Schema.Literals(["chat", "media", "execution"]), id: Schema.String },
) {}

export class IncompatibleCatalogRoutes extends Schema.TaggedError<IncompatibleCatalogRoutes>()(
  "IncompatibleCatalogRoutes",
  {
    chatRouteId: Schema.String,
    mediaRouteId: Schema.String,
    reason: Schema.Literals(["media_generation_unsupported"]),
  },
) {}

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
    verified:
      mechanism !== "openai_compatible" &&
      status.status === "signed-in" &&
      status.provider === provider,
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
      const authByProvider = MutableHashMap.empty<ProviderId, RouteAuthEvidence>();

      for (const provider of [...providers.providers].toSorted()) {
        const configuration = yield* providers.get(provider).pipe(
          Effect.mapError(
            (cause) =>
              new RouteCatalogRefreshFailed({
                provider,
                operation: "provider",
                reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
                cause,
              }),
          ),
        );
        const status = yield* configuration.auth.status.pipe(
          Effect.mapError(
            (cause) =>
              new RouteCatalogRefreshFailed({
                provider,
                operation: "auth",
                reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
                cause,
              }),
          ),
        );
        const connection = providerConnection(provider);
        const authentication = authEvidence(
          provider,
          status,
          connection.type === "compatible-endpoint" ? "openai_compatible" : "subscription_oauth",
        );
        MutableHashMap.set(authByProvider, provider, authentication);
        const models = yield* configuration.models.list.pipe(
          Effect.mapError(
            (cause) =>
              new RouteCatalogRefreshFailed({
                provider,
                operation: "models",
                reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
                cause,
              }),
          ),
        );
        for (const model of models) {
          if (model.provider !== provider)
            return yield* new RouteCatalogRefreshFailed({
              provider,
              operation: "models",
              reason: RouteCatalogRefreshFailedReason.cases.ProviderMismatch.make({}),
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
              source:
                connection.type === "compatible-endpoint"
                  ? "endpoint_configuration"
                  : "provider_model_catalog",
              detail:
                connection.type === "compatible-endpoint"
                  ? "Model is configured locally; endpoint authentication and model access are unverified."
                  : "Model was returned by the configured provider catalog.",
            }),
          });
          chat.push(chatRoute);

          const support = connection.nativeTools;
          const resolved = yield* (() => {
            switch (support.type) {
              case "unsupported":
                return Effect.succeed([]);
              case "vendor-native":
                return tools.resolve({ provider: support.vendor, model: model.id }).pipe(
                  Effect.catchTag("UnknownProviderToolModel", () => Effect.succeed([])),
                  Effect.mapError(
                    (cause) =>
                      new RouteCatalogRefreshFailed({
                        provider,
                        operation: "tools",
                        reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
                        cause,
                      }),
                  ),
                );
            }
          })();
          for (const descriptor of resolved) {
            execution.push(
              Object.freeze({
                type: "execution",
                id: `execution:${descriptor.provider}:${model.id}:${descriptor.id}`,
                provider: descriptor.provider,
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

      const openAIKey = yield* Config.String("OPENAI_API_KEY")
        .pipe(Config.option)
        .parse(ConfigProvider.fromEnv())
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteCatalogRefreshFailed({
                operation: "config",
                reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
                cause,
              }),
          ),
        );
      const openAIAuth =
        Option.getOrUndefined(MutableHashMap.get(authByProvider, "openai")) ??
        authEvidence("openai", { provider: "openai", status: "signed-out" }, "subscription_oauth");
      for (const contract of imageRouteContracts) {
        const authentication =
          contract.executionMode === "direct_adapter"
            ? Object.freeze({
                mechanism: "openai_api_key" as const,
                status: Option.isNone(openAIKey) ? ("signed-out" as const) : ("signed-in" as const),
                verified: Option.isSome(openAIKey),
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

export const makeRouteCatalog: {
  (source: RouteCatalogSource, now?: () => number): Effect.Effect<RouteCatalogApi>;
  (now?: () => number): (source: RouteCatalogSource) => Effect.Effect<RouteCatalogApi>;
} = EffectFunction.dual(
  (args) => args.length > 1 || (args[0] !== undefined && !Predicate.isFunction(args[0])),
  makeRouteCatalogBody,
);
function makeRouteCatalogBody(
  source: RouteCatalogSource,
  now?: () => number,
): Effect.Effect<RouteCatalogApi> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const state = yield* Ref.make<RouteCatalogSnapshot>(
      freezeSnapshot({ revision: 0, refreshedAt: 0, chat: [], media: [], execution: [] }),
    );
    const refresh = Effect.gen(function* () {
      const loaded = yield* source.load;
      const refreshedAt = now === undefined ? clock.currentTimeMillisUnsafe() : now();
      return yield* Ref.updateAndGet(state, (previous) =>
        freezeSnapshot({ ...loaded, revision: previous.revision + 1, refreshedAt }),
      );
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
              reason: "media_generation_unsupported",
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
  "memory-agent/providers/route-catalog/RouteCatalog",
) {
  static readonly layer = Layer.effect(
    RouteCatalog,
    Effect.flatMap(sourceFromServices, (source) => makeRouteCatalog(source)),
  );
  static readonly layerFrom = (source: RouteCatalogSource, now?: () => number) =>
    Layer.effect(RouteCatalog, makeRouteCatalog(source, now));
}
