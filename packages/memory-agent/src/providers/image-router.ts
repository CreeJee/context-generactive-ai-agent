import {
  Array as EffectArray,
  MutableHashMap,
  Option,
  Context,
  Data,
  Effect,
  Layer,
  Schema,
} from "effect";
import { failedReasons } from "./failed-checks.ts";
import { optionalProperty } from "../optional-property.ts";
import {
  RouteCatalog,
  type ChatRoute,
  type MediaRoute,
  type RouteCatalogApi,
} from "./route-catalog.ts";
import type { CrossProviderMediaConsentMode } from "../config/global-config.ts";
import {
  CrossProviderMediaConsent,
  type CrossProviderMediaConsentApi,
} from "./cross-provider-media-consent.ts";

export type ImageRoutingPreference = "balanced" | "quality" | "speed" | "cost";
export type ImageRoutingMode = "auto" | "fixed";

export interface ImageRoutingIntent {
  readonly operation: "generate" | "edit";
  readonly sourceImageCount: number;
  readonly requiresMask: boolean;
}

export interface ImageRoutingPolicy {
  readonly mode: ImageRoutingMode;
  readonly fixedRouteId?: MediaRoute["id"];
  readonly preference?: ImageRoutingPreference;
  readonly allowedProviders?: readonly MediaRoute["provider"][];
  readonly allowedExecutionModes?: readonly MediaRoute["executionMode"][];
  readonly maximumEstimatedCostUsd?: number;
  readonly allowUnknownCost?: boolean;
}

export interface ImageRouteFact {
  readonly routeId: MediaRoute["id"];
  readonly accountId: string;
  readonly available: boolean;
  readonly quality: number;
  readonly speed: number;
  readonly estimatedCostUsd?: number;
  readonly evidence: readonly string[];
}

/** A fact's invalid cost is kept as reported (it makes the route ineligible), so cost-derived numbers may be NaN. */
export const ImageRouteScore = Schema.Struct({
  routeId: Schema.TemplateLiteral(["media:", Schema.String]),
  eligible: Schema.Boolean,
  // @effect-diagnostics-next-line schemaNumber:off
  score: Schema.Number,
  quality: Schema.Finite,
  speed: Schema.Finite,
  // @effect-diagnostics-next-line schemaNumber:off
  affordability: Schema.Number,
  // @effect-diagnostics-next-line schemaNumber:off
  estimatedCostUsd: Schema.optionalKey(Schema.Number),
  reasons: Schema.Array(Schema.String),
});
export type ImageRouteScore = typeof ImageRouteScore.Type;

/** The route chosen for one image request. */
export type ImageRouteDecision = Data.TaggedEnum<{
  selected: {
    readonly mode: ImageRoutingMode;
    readonly preference: ImageRoutingPreference;
    readonly initiatorChatRouteId: ChatRoute["id"];
    readonly initiatorChatModel: string;
    readonly executorMediaRouteId: MediaRoute["id"];
    readonly executorMediaModel: MediaRoute["executorModel"];
    readonly provider: MediaRoute["provider"];
    readonly initiatorProvider: ChatRoute["provider"];
    readonly crossProvider: boolean;
    readonly crossProviderConsentMode: CrossProviderMediaConsentMode;
    readonly crossProviderApprovalRequired: boolean;
    readonly accountId: string;
    readonly executionMode: MediaRoute["executionMode"];
    readonly estimatedCostUsd?: number;
    readonly score: number;
    readonly reasons: readonly string[];
    readonly ranking: readonly ImageRouteScore[];
  };
}>;
export const ImageRouteDecision = Data.taggedEnum<ImageRouteDecision>();

/** Routes a failed image request may move to, each needing the user's confirmation. */
export type ImageRerouteConfirmation = Data.TaggedEnum<{
  confirmation_required: {
    readonly failedDecision: ImageRouteDecision;
    readonly reason: string;
    readonly alternatives: readonly ImageRouteDecision[];
  };
}>;
export const ImageRerouteConfirmation = Data.taggedEnum<ImageRerouteConfirmation>();

export class ImageRouteFactsFailed extends Schema.TaggedError<
  ImageRouteFactsFailed,
  { readonly brand: unique symbol }
>()("ImageRouteFactsFailed", {
  routeId: Schema.optionalKey(Schema.String),
  cause: Schema.Defect(),
}) {}

export class ImageRoutingInvalidRequest extends Schema.TaggedError<
  ImageRoutingInvalidRequest,
  { readonly brand: unique symbol }
>()("ImageRoutingInvalidRequest", {
  reason: Schema.Literals([
    "invalid_source_image_count",
    "invalid_cost_ceiling",
    /** A route fact's quality or speed is outside 0..1. */
    "invalid_route_fact_score",
    "unknown_initiator_route",
  ]),
  routeId: Schema.optionalKey(Schema.String),
}) {}

export class ImageRouteUnavailable extends Schema.TaggedError<
  ImageRouteUnavailable,
  { readonly brand: unique symbol }
>()("ImageRouteUnavailable", { ranking: Schema.Array(ImageRouteScore) }) {}

export const FixedImageRouteRejectedReason = Schema.TaggedUnion({
  /** Fixed mode was asked for without naming a route. */
  RouteIdMissing: {},
  RouteAbsent: {},
  /** The route is in the catalog but its score is not eligible; `reasons` are the score's. */
  Ineligible: { reasons: Schema.Array(Schema.String) },
});

export class FixedImageRouteRejected extends Schema.TaggedError<
  FixedImageRouteRejected,
  { readonly brand: unique symbol }
>()("FixedImageRouteRejected", {
  routeId: Schema.optionalKey(Schema.String),
  reason: FixedImageRouteRejectedReason,
}) {}

export interface ImageRouteFactsApi {
  readonly forRoutes: (
    routes: readonly MediaRoute[],
  ) => Effect.Effect<readonly ImageRouteFact[], ImageRouteFactsFailed>;
}

export class ImageRouteFacts extends Context.Service<ImageRouteFacts, ImageRouteFactsApi>()(
  "memory-agent/providers/image-router/ImageRouteFacts",
) {
  static readonly layerFrom = (api: ImageRouteFactsApi) => Layer.succeed(ImageRouteFacts, api);
  static readonly unavailableLayer = Layer.succeed(ImageRouteFacts, {
    forRoutes: (routes) =>
      Effect.succeed(
        routes.map((route) => ({
          routeId: route.id,
          accountId: "unverified",
          available: false,
          quality: 0,
          speed: 0,
          evidence: ["No account image-route capability source configured."],
        })),
      ),
  });
  static readonly authenticatedRoutesLayer = Layer.succeed(ImageRouteFacts, {
    forRoutes: (routes) =>
      Effect.succeed(
        routes.map((route) => {
          const available =
            route.executionMode === "direct_adapter" && route.authentication.verified;
          const profile = route.id.endsWith(":gpt-image-2")
            ? { quality: 1, speed: 0.45 }
            : route.id.endsWith(":gpt-image-1-mini")
              ? { quality: 0.7, speed: 0.8 }
              : { quality: 0.8, speed: 0.55 };
          return {
            routeId: route.id,
            accountId: available ? "openai-api-key" : "unverified",
            available,
            quality: profile.quality,
            speed: profile.speed,
            evidence: [
              available
                ? "OpenAI API key is configured; account image access is validated by execution."
                : "An authenticated direct image route is not configured.",
            ],
          };
        }),
      ),
  });
}

export interface RankImageRoutesInput {
  readonly routes: readonly MediaRoute[];
  readonly facts: readonly ImageRouteFact[];
  readonly intent: ImageRoutingIntent;
  readonly policy: ImageRoutingPolicy;
}

const finiteUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

function validateInput(input: RankImageRoutesInput): Option.Option<ImageRoutingInvalidRequest> {
  if (!Number.isInteger(input.intent.sourceImageCount) || input.intent.sourceImageCount < 0)
    return Option.some(ImageRoutingInvalidRequest.make({ reason: "invalid_source_image_count" }));
  if (
    input.policy.maximumEstimatedCostUsd !== undefined &&
    (!Number.isFinite(input.policy.maximumEstimatedCostUsd) ||
      input.policy.maximumEstimatedCostUsd < 0)
  )
    return Option.some(ImageRoutingInvalidRequest.make({ reason: "invalid_cost_ceiling" }));
  return Option.map(
    EffectArray.findFirst(
      input.facts,
      (fact) => !finiteUnit(fact.quality) || !finiteUnit(fact.speed),
    ),
    (fact) =>
      ImageRoutingInvalidRequest.make({
        reason: "invalid_route_fact_score",
        routeId: fact.routeId,
      }),
  );
}

const weights: Record<
  ImageRoutingPreference,
  Readonly<{ quality: number; speed: number; affordability: number }>
> = {
  balanced: { quality: 0.4, speed: 0.3, affordability: 0.3 },
  quality: { quality: 0.7, speed: 0.15, affordability: 0.15 },
  speed: { quality: 0.15, speed: 0.7, affordability: 0.15 },
  cost: { quality: 0.15, speed: 0.15, affordability: 0.7 },
};

function scoreRoute(
  route: MediaRoute,
  fact: ImageRouteFact | undefined,
  intent: ImageRoutingIntent,
  policy: ImageRoutingPolicy,
): ImageRouteScore {
  const cost = fact?.estimatedCostUsd;
  const ceiling = policy.maximumEstimatedCostUsd;
  const reasons = failedReasons([
    [route.contract.verification !== "verified", "route contract is not verified"],
    [!route.authentication.verified, "provider account is not authenticated"],
    [!route.contract.productionEnabled, "route is not production-enabled"],
    [!route.operations.includes(intent.operation), `route does not support ${intent.operation}`],
    [
      intent.sourceImageCount > route.contract.input.maximumSourceImages,
      `route accepts at most ${route.contract.input.maximumSourceImages} source images`,
    ],
    [
      intent.sourceImageCount > 0 && !route.contract.input.images,
      "route does not accept source images",
    ],
    [intent.requiresMask && !route.contract.input.mask, "route does not support masks"],
    [
      policy.allowedProviders !== undefined && !policy.allowedProviders.includes(route.provider),
      "provider is excluded by policy",
    ],
    [
      policy.allowedExecutionModes !== undefined &&
        !policy.allowedExecutionModes.includes(route.executionMode),
      "execution mode is excluded by policy",
    ],
    [fact === undefined, "account route facts are unavailable"],
    [fact !== undefined && !fact.available, "route is unavailable for the account"],
    [cost !== undefined && (!Number.isFinite(cost) || cost < 0), "estimated cost is invalid"],
    [
      ceiling !== undefined && cost === undefined && policy.allowUnknownCost !== true,
      "cost is unknown under a strict cost ceiling",
    ],
    [
      ceiling !== undefined && cost !== undefined && cost > ceiling,
      "estimated cost exceeds the cost ceiling",
    ],
  ]);

  const affordability =
    cost === undefined
      ? 0
      : policy.maximumEstimatedCostUsd !== undefined && policy.maximumEstimatedCostUsd > 0
        ? Math.max(0, 1 - cost / policy.maximumEstimatedCostUsd)
        : 1 / (1 + cost);
  const preference = policy.preference ?? "balanced";
  const weight = weights[preference];
  const score =
    fact === undefined
      ? 0
      : fact.quality * weight.quality +
        fact.speed * weight.speed +
        affordability * weight.affordability;
  return Object.freeze({
    routeId: route.id,
    eligible: reasons.length === 0,
    score,
    quality: fact?.quality ?? 0,
    speed: fact?.speed ?? 0,
    affordability,
    ...optionalProperty("estimatedCostUsd", cost),
    reasons: Object.freeze(reasons),
  });
}

export function rankImageRoutes(
  input: RankImageRoutesInput,
): Effect.Effect<readonly ImageRouteScore[], ImageRoutingInvalidRequest> {
  return Option.match(validateInput(input), {
    onSome: (invalid) => Effect.fail(invalid),
    onNone: () => {
      const facts = MutableHashMap.fromIterable(input.facts.map((fact) => [fact.routeId, fact]));
      const ranking = input.routes
        .map((route) =>
          scoreRoute(
            route,
            Option.getOrUndefined(MutableHashMap.get(facts, route.id)),
            input.intent,
            input.policy,
          ),
        )
        .toSorted(
          (left, right) => right.score - left.score || left.routeId.localeCompare(right.routeId),
        );
      return Effect.succeed(Object.freeze(ranking));
    },
  });
}

export interface ImageRouterRequest {
  readonly initiatorChatRouteId: ChatRoute["id"];
  readonly intent: ImageRoutingIntent;
  readonly policy: ImageRoutingPolicy;
}

export interface ImageRouterApi {
  readonly select: (
    request: ImageRouterRequest,
  ) => Effect.Effect<
    ImageRouteDecision,
    | ImageRouteFactsFailed
    | ImageRoutingInvalidRequest
    | ImageRouteUnavailable
    | FixedImageRouteRejected
  >;
  readonly rerouteAfterFailure: (
    decision: ImageRouteDecision,
    reason: string,
    request: ImageRouterRequest,
  ) => Effect.Effect<
    ImageRerouteConfirmation,
    | ImageRouteFactsFailed
    | ImageRoutingInvalidRequest
    | ImageRouteUnavailable
    | FixedImageRouteRejected
  >;
}

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function makeImageRouter(options: {
  readonly catalog: RouteCatalogApi;
  readonly factsService: ImageRouteFactsApi;
  readonly crossProviderConsent?: CrossProviderMediaConsentApi | undefined;
}) {
  return makeImageRouterBody(options.catalog, options.factsService, options.crossProviderConsent);
}
function makeImageRouterBody(
  catalog: RouteCatalogApi,
  factsService: ImageRouteFactsApi,
  crossProviderConsent?: CrossProviderMediaConsentApi,
): ImageRouterApi {
  const decisions = (request: ImageRouterRequest) =>
    Effect.gen(function* () {
      const snapshot = yield* catalog.snapshot;
      const chat = yield* catalog.chat(request.initiatorChatRouteId).pipe(
        Effect.mapError(() =>
          ImageRoutingInvalidRequest.make({
            reason: "unknown_initiator_route",
            routeId: request.initiatorChatRouteId,
          }),
        ),
      );
      const consentByRoute = MutableHashMap.empty<string, CrossProviderMediaConsentMode>();
      const routes =
        crossProviderConsent === undefined
          ? snapshot.media
          : yield* Effect.filter(snapshot.media, (route) =>
              crossProviderConsent
                .decide({
                  initiatorProvider: chat.provider,
                  executorProvider: route.provider,
                  capability: "media.image.generate",
                })
                .pipe(
                  Effect.map((decision) => {
                    MutableHashMap.set(consentByRoute, route.id, decision.mode);
                    return !decision.crossProvider || decision.mode !== "disabled";
                  }),
                  // An unreadable consent leaves the cross-provider route out of the candidates.
                  Effect.catchTag("CrossProviderMediaConsentStoreFailed", () =>
                    Effect.succeed(false),
                  ),
                ),
            );
      const facts = yield* factsService.forRoutes(routes);
      const ranking = yield* rankImageRoutes({
        routes,
        facts,
        intent: request.intent,
        policy: request.policy,
      });
      const routeById = MutableHashMap.fromIterable(routes.map((route) => [route.id, route]));
      const factById = MutableHashMap.fromIterable(facts.map((fact) => [fact.routeId, fact]));
      return {
        chat,
        ranking,
        routeById,
        factById,
        consentByRoute,
      };
    });

  const select = (request: ImageRouterRequest) =>
    Effect.gen(function* () {
      const result = yield* decisions(request);
      const selectedScore =
        request.policy.mode === "fixed"
          ? result.ranking.find((score) => score.routeId === request.policy.fixedRouteId)
          : result.ranking.find((score) => score.eligible);
      if (request.policy.mode === "fixed") {
        if (request.policy.fixedRouteId === undefined)
          return yield* FixedImageRouteRejected.make({
            reason: FixedImageRouteRejectedReason.cases.RouteIdMissing.make({}),
          });
        if (selectedScore === undefined)
          return yield* FixedImageRouteRejected.make({
            routeId: request.policy.fixedRouteId,
            reason: FixedImageRouteRejectedReason.cases.RouteAbsent.make({}),
          });
        if (!selectedScore.eligible)
          return yield* FixedImageRouteRejected.make({
            routeId: request.policy.fixedRouteId,
            reason: FixedImageRouteRejectedReason.cases.Ineligible.make({
              reasons: selectedScore.reasons,
            }),
          });
      }
      const selected = yield* Effect.fromOption(Option.fromUndefinedOr(selectedScore), () =>
        ImageRouteUnavailable.make({ ranking: result.ranking }),
      );
      const route = Option.getOrUndefined(MutableHashMap.get(result.routeById, selected.routeId))!;
      const fact = Option.getOrUndefined(MutableHashMap.get(result.factById, selected.routeId))!;
      const preference = request.policy.preference ?? "balanced";
      return Object.freeze(
        ImageRouteDecision.selected({
          mode: request.policy.mode,
          preference,
          initiatorChatRouteId: result.chat.id,
          initiatorChatModel: result.chat.model,
          executorMediaRouteId: route.id,
          executorMediaModel: route.executorModel,
          provider: route.provider,
          initiatorProvider: result.chat.provider,
          crossProvider: result.chat.provider !== route.provider,
          crossProviderConsentMode:
            Option.getOrUndefined(MutableHashMap.get(result.consentByRoute, route.id)) ??
            (result.chat.provider === route.provider ? "always" : "disabled"),
          crossProviderApprovalRequired:
            result.chat.provider !== route.provider &&
            Option.getOrUndefined(MutableHashMap.get(result.consentByRoute, route.id)) === "ask",
          accountId: fact.accountId,
          executionMode: route.executionMode,
          ...optionalProperty("estimatedCostUsd", selected.estimatedCostUsd),
          score: selected.score,
          reasons: Object.freeze([
            `${preference} preference selected the highest eligible deterministic score`,
            ...fact.evidence,
          ]),
          ranking: result.ranking,
        }),
      );
    });

  return {
    select,
    rerouteAfterFailure: (decision, reason, request) =>
      Effect.gen(function* () {
        const result = yield* decisions({
          ...request,
          policy: { ...request.policy, mode: "auto" },
        });
        const alternatives = result.ranking
          .filter(
            (candidate) =>
              candidate.eligible && candidate.routeId !== decision.executorMediaRouteId,
          )
          .map((candidate): ImageRouteDecision => {
            const route = Option.getOrUndefined(
              MutableHashMap.get(result.routeById, candidate.routeId),
            )!;
            const fact = Option.getOrUndefined(
              MutableHashMap.get(result.factById, candidate.routeId),
            )!;
            return Object.freeze({
              ...decision,
              mode: "auto",
              executorMediaRouteId: route.id,
              executorMediaModel: route.executorModel,
              provider: route.provider,
              accountId: fact.accountId,
              executionMode: route.executionMode,
              ...optionalProperty("estimatedCostUsd", candidate.estimatedCostUsd),
              score: candidate.score,
              reasons: Object.freeze([
                "Alternative requires explicit user confirmation.",
                ...fact.evidence,
              ]),
              ranking: result.ranking,
            });
          });
        return Object.freeze(
          ImageRerouteConfirmation.confirmation_required({
            failedDecision: decision,
            reason,
            alternatives: Object.freeze(alternatives),
          }),
        );
      }),
  };
}

export class ImageRouter extends Context.Service<ImageRouter, ImageRouterApi>()(
  "memory-agent/providers/image-router/ImageRouter",
) {
  static readonly layer = Layer.effect(
    ImageRouter,
    Effect.gen(function* () {
      return makeImageRouter({
        catalog: yield* RouteCatalog,
        factsService: yield* ImageRouteFacts,
      });
    }),
  );
  static readonly consentLayer = Layer.effect(
    ImageRouter,
    Effect.gen(function* () {
      return makeImageRouter({
        catalog: yield* RouteCatalog,
        factsService: yield* ImageRouteFacts,
        crossProviderConsent: yield* CrossProviderMediaConsent,
      });
    }),
  );
  static readonly layerFrom = (api: ImageRouterApi) => Layer.succeed(ImageRouter, api);
}
