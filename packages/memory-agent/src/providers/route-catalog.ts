import { providerConnection, type ProviderVendor } from "./contracts.ts";
import {
  Clock,
  Function as EffectFunction,
  Predicate,
  Array as EffectArray,
  HashMap,
  ConfigProvider,
  Option,
  Config,
  Context,
  Effect,
  Layer,
  Ref,
  Schema,
} from "effect";
import {
  AuthConnectionState,
  NativeToolSupport,
  ProviderConnection,
  ProviderId,
  type AuthStatus,
  type ProviderModel,
} from "./contracts.ts";
import type { ImageRouteContract } from "./image-contracts.ts";
import { imageRouteContracts } from "./image-contracts.ts";
import { ProviderRegistry } from "./registry.ts";
import {
  ProviderToolCapabilityRegistry,
  type ProviderToolAuth,
  type ProviderToolCategory,
  type ProviderToolCost,
} from "./tool-capabilities.ts";
import type { ProviderToolId } from "./provider-tool-id.ts";

export type RouteEvidenceStatus = "verified" | "unverified" | "unsupported";

export interface RouteAuthEvidence {
  readonly mechanism: "subscription_oauth" | "openai_api_key" | "openai_compatible";
  readonly status: AuthStatus;
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

/** The case a connection is in, as route evidence names it. */
const authStatus = AuthConnectionState.$match({
  "signed-out": () => "signed-out" as const,
  pending: () => "pending" as const,
  "signed-in": () => "signed-in" as const,
  error: () => "error" as const,
});

const authEvidence = (
  provider: ProviderId,
  state: AuthConnectionState,
  mechanism: RouteAuthEvidence["mechanism"],
): RouteAuthEvidence => {
  const signedIn = AuthConnectionState.$is("signed-in")(state) ? state : null;
  const evidence: RouteAuthEvidence = {
    mechanism,
    status: authStatus(state),
    verified: mechanism !== "openai_compatible" && signedIn?.provider === provider,
  };
  return Object.freeze(
    signedIn?.planType !== undefined ? { ...evidence, planType: signedIn.planType } : evidence,
  );
};

const sourceFromServices = Effect.gen(function* () {
  const providers = yield* ProviderRegistry;
  const tools = yield* ProviderToolCapabilityRegistry;

  /** One provider's chat and tool execution routes, with how it is signed in. */
  const providerRoutes = (provider: ProviderId) =>
    Effect.gen(function* () {
      const configuration = yield* providers.get(provider).pipe(
        Effect.mapError((cause) =>
          RouteCatalogRefreshFailed.make({
            provider,
            operation: "provider",
            reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
            cause,
          }),
        ),
      );
      const status = yield* configuration.auth.status.pipe(
        Effect.mapError((cause) =>
          RouteCatalogRefreshFailed.make({
            provider,
            operation: "auth",
            reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
            cause,
          }),
        ),
      );
      const connection = providerConnection(provider);
      const compatible = ProviderConnection.isAnyOf(["compatible-endpoint"])(connection);
      const authentication = authEvidence(
        provider,
        status,
        compatible ? "openai_compatible" : "subscription_oauth",
      );
      const models = yield* configuration.models.list.pipe(
        Effect.mapError((cause) =>
          RouteCatalogRefreshFailed.make({
            provider,
            operation: "models",
            reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
            cause,
          }),
        ),
      );
      const modelRoutes = yield* Effect.forEach(models, (model) =>
        Effect.succeed(model).pipe(
          Effect.filterOrFail(
            (listed) => listed.provider === provider,
            () =>
              RouteCatalogRefreshFailed.make({
                provider,
                operation: "models",
                reason: RouteCatalogRefreshFailedReason.cases.ProviderMismatch.make({}),
              }),
          ),
          Effect.andThen(
            NativeToolSupport.match(connection.nativeTools, {
              unsupported: () => Effect.succeed([]),
              "vendor-native": ({ vendor }) =>
                tools.resolve({ provider: vendor, model: model.id }).pipe(
                  Effect.catchTag("UnknownProviderToolModel", () => Effect.succeed([])),
                  Effect.mapError((cause) =>
                    RouteCatalogRefreshFailed.make({
                      provider,
                      operation: "tools",
                      reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
                      cause,
                    }),
                  ),
                ),
            }),
          ),
          Effect.map((resolved) => ({
            chat: Object.freeze({
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
                source: compatible ? "endpoint_configuration" : "provider_model_catalog",
                detail: compatible
                  ? "Model is configured locally; endpoint authentication and model access are unverified."
                  : "Model was returned by the configured provider catalog.",
              }),
            }) satisfies ChatRoute,
            execution: resolved.map((descriptor): ExecutionRoute =>
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
            ),
          })),
        ),
      );
      return {
        provider,
        authentication,
        chat: modelRoutes.map((routes): ChatRoute => routes.chat),
        execution: modelRoutes.flatMap((routes) => routes.execution),
      };
    });

  return {
    load: Effect.gen(function* () {
      const loaded = yield* Effect.forEach([...providers.providers].toSorted(), providerRoutes);
      const authByProvider = HashMap.fromIterable(
        loaded.map(({ provider, authentication }) => [provider, authentication] as const),
      );

      const openAIKey = yield* Config.String("OPENAI_API_KEY")
        .pipe(Config.option)
        .parse(ConfigProvider.fromEnv())
        .pipe(
          Effect.mapError((cause) =>
            RouteCatalogRefreshFailed.make({
              operation: "config",
              reason: RouteCatalogRefreshFailedReason.cases.Failed.make({}),
              cause,
            }),
          ),
        );
      const openAIAuth = Option.getOrElse(HashMap.get(authByProvider, "openai"), () =>
        authEvidence(
          "openai",
          AuthConnectionState["signed-out"]({ provider: "openai" }),
          "subscription_oauth",
        ),
      );
      const media = imageRouteContracts.map((contract): MediaRoute =>
        Object.freeze({
          type: "media",
          id: `media:${contract.id}`,
          provider: contract.provider,
          executionMode: contract.executionMode,
          executorModel: contract.executorModel,
          operations: contract.operations,
          authentication:
            contract.executionMode === "direct_adapter"
              ? Object.freeze({
                  mechanism: "openai_api_key" as const,
                  status: Option.isNone(openAIKey)
                    ? ("signed-out" as const)
                    : ("signed-in" as const),
                  verified: Option.isSome(openAIKey),
                })
              : openAIAuth,
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
      return {
        chat: loaded.flatMap((routes) => routes.chat).toSorted(compareId),
        media: media.toSorted(compareId),
        execution: loaded.flatMap((routes) => routes.execution).toSorted(compareId),
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
    const state = yield* Ref.make<RouteCatalogSnapshot>(
      freezeSnapshot({ revision: 0, refreshedAt: 0, chat: [], media: [], execution: [] }),
    );
    const refresh = Effect.gen(function* () {
      const loaded = yield* source.load;
      const refreshedAt = now === undefined ? yield* Clock.currentTimeMillis : now();
      return yield* Ref.updateAndGet(state, (previous) =>
        freezeSnapshot({ ...loaded, revision: previous.revision + 1, refreshedAt }),
      );
    });
    const find = <Route extends { readonly id: string }>(
      routeType: UnknownCatalogRoute["routeType"],
      routes: readonly Route[],
      id: string,
    ): Effect.Effect<Route, UnknownCatalogRoute> =>
      Effect.fromOption(
        EffectArray.findFirst(routes, (candidate) => candidate.id === id),
        () => UnknownCatalogRoute.make({ routeType, id }),
      );
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
          const mediaRoute = yield* find("media", snapshot.media, mediaRouteId).pipe(
            Effect.filterOrFail(
              (route) => route.operations.includes("generate"),
              () =>
                IncompatibleCatalogRoutes.make({
                  chatRouteId,
                  mediaRouteId,
                  reason: "media_generation_unsupported",
                }),
            ),
          );
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
