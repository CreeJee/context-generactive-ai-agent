import { Context, Data, Effect, Layer } from "effect";
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

export interface ImageRouteScore {
  readonly routeId: MediaRoute["id"];
  readonly eligible: boolean;
  readonly score: number;
  readonly quality: number;
  readonly speed: number;
  readonly affordability: number;
  readonly estimatedCostUsd?: number;
  readonly reasons: readonly string[];
}

export interface ImageRouteDecision {
  readonly type: "selected";
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
}

export interface ImageRerouteConfirmation {
  readonly type: "confirmation_required";
  readonly failedDecision: ImageRouteDecision;
  readonly reason: string;
  readonly alternatives: readonly ImageRouteDecision[];
}

export class ImageRouteFactsFailed extends Data.TaggedError("ImageRouteFactsFailed")<{
  readonly routeId?: string;
  readonly cause: unknown;
}> {}

export class ImageRoutingInvalidRequest extends Data.TaggedError("ImageRoutingInvalidRequest")<{
  readonly reason: string;
}> {}

export class ImageRouteUnavailable extends Data.TaggedError("ImageRouteUnavailable")<{
  readonly reasons: readonly string[];
  readonly ranking: readonly ImageRouteScore[];
}> {}

export class FixedImageRouteRejected extends Data.TaggedError("FixedImageRouteRejected")<{
  readonly routeId?: string;
  readonly reasons: readonly string[];
}> {}

export interface ImageRouteFactsApi {
  readonly forRoutes: (
    routes: readonly MediaRoute[],
  ) => Effect.Effect<readonly ImageRouteFact[], ImageRouteFactsFailed>;
}

export class ImageRouteFacts extends Context.Service<ImageRouteFacts, ImageRouteFactsApi>()(
  "memory-agent/ImageRouteFacts",
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
    forRoutes: (routes) => {
      return Effect.succeed(
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
      );
    },
  });
}

export interface RankImageRoutesInput {
  readonly routes: readonly MediaRoute[];
  readonly facts: readonly ImageRouteFact[];
  readonly intent: ImageRoutingIntent;
  readonly policy: ImageRoutingPolicy;
}

const finiteUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

function validateInput(input: RankImageRoutesInput): ImageRoutingInvalidRequest | undefined {
  if (!Number.isInteger(input.intent.sourceImageCount) || input.intent.sourceImageCount < 0)
    return new ImageRoutingInvalidRequest({
      reason: "sourceImageCount must be a non-negative integer",
    });
  if (
    input.policy.maximumEstimatedCostUsd !== undefined &&
    (!Number.isFinite(input.policy.maximumEstimatedCostUsd) ||
      input.policy.maximumEstimatedCostUsd < 0)
  )
    return new ImageRoutingInvalidRequest({
      reason: "maximumEstimatedCostUsd must be a finite non-negative number",
    });
  for (const fact of input.facts)
    if (!finiteUnit(fact.quality) || !finiteUnit(fact.speed))
      return new ImageRoutingInvalidRequest({
        reason: `route fact scores must be within 0..1: ${fact.routeId}`,
      });
  return undefined;
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
  const reasons: string[] = [];
  if (route.contract.verification !== "verified") reasons.push("route contract is not verified");
  if (!route.authentication.verified) reasons.push("provider account is not authenticated");
  if (!route.contract.productionEnabled) reasons.push("route is not production-enabled");
  if (!route.operations.includes(intent.operation))
    reasons.push(`route does not support ${intent.operation}`);
  if (intent.sourceImageCount > route.contract.input.maximumSourceImages)
    reasons.push(`route accepts at most ${route.contract.input.maximumSourceImages} source images`);
  if (intent.sourceImageCount > 0 && !route.contract.input.images)
    reasons.push("route does not accept source images");
  if (intent.requiresMask && !route.contract.input.mask)
    reasons.push("route does not support masks");
  if (policy.allowedProviders !== undefined && !policy.allowedProviders.includes(route.provider))
    reasons.push("provider is excluded by policy");
  if (
    policy.allowedExecutionModes !== undefined &&
    !policy.allowedExecutionModes.includes(route.executionMode)
  )
    reasons.push("execution mode is excluded by policy");
  if (fact === undefined) reasons.push("account route facts are unavailable");
  else if (!fact.available) reasons.push("route is unavailable for the account");

  const cost = fact?.estimatedCostUsd;
  if (cost !== undefined && (!Number.isFinite(cost) || cost < 0))
    reasons.push("estimated cost is invalid");
  if (policy.maximumEstimatedCostUsd !== undefined) {
    if (cost === undefined && policy.allowUnknownCost !== true)
      reasons.push("cost is unknown under a strict cost ceiling");
    else if (cost !== undefined && cost > policy.maximumEstimatedCostUsd)
      reasons.push("estimated cost exceeds the cost ceiling");
  }

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
  const invalid = validateInput(input);
  if (invalid !== undefined) return Effect.fail(invalid);
  const facts = new Map(input.facts.map((fact) => [fact.routeId, fact]));
  const ranking = input.routes
    .map((route) => scoreRoute(route, facts.get(route.id), input.intent, input.policy))
    .toSorted(
      (left, right) => right.score - left.score || left.routeId.localeCompare(right.routeId),
    );
  return Effect.succeed(Object.freeze(ranking));
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

export function makeImageRouter(
  catalog: RouteCatalogApi,
  factsService: ImageRouteFactsApi,
  crossProviderConsent?: CrossProviderMediaConsentApi,
): ImageRouterApi {
  const decisions = (request: ImageRouterRequest) =>
    Effect.gen(function* () {
      const snapshot = yield* catalog.snapshot;
      const chat = yield* catalog.chat(request.initiatorChatRouteId).pipe(
        Effect.mapError(
          () =>
            new ImageRoutingInvalidRequest({
              reason: `unknown initiator chat route: ${request.initiatorChatRouteId}`,
            }),
        ),
      );
      const consentByRoute = new Map<string, CrossProviderMediaConsentMode>();
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
                    consentByRoute.set(route.id, decision.mode);
                    return !decision.crossProvider || decision.mode !== "disabled";
                  }),
                  Effect.orElseSucceed(() => false),
                ),
            );
      const facts = yield* factsService.forRoutes(routes);
      const ranking = yield* rankImageRoutes({
        routes,
        facts,
        intent: request.intent,
        policy: request.policy,
      });
      const routeById = new Map(routes.map((route) => [route.id, route]));
      const factById = new Map(facts.map((fact) => [fact.routeId, fact]));
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
          return yield* new FixedImageRouteRejected({
            reasons: ["fixed mode requires fixedRouteId"],
          });
        if (selectedScore === undefined || !selectedScore.eligible)
          return yield* new FixedImageRouteRejected({
            routeId: request.policy.fixedRouteId,
            reasons: selectedScore?.reasons ?? ["fixed route is absent from the catalog"],
          });
      }
      if (selectedScore === undefined)
        return yield* new ImageRouteUnavailable({
          reasons: ["no eligible image route"],
          ranking: result.ranking,
        });
      const route = result.routeById.get(selectedScore.routeId)!;
      const fact = result.factById.get(selectedScore.routeId)!;
      const preference = request.policy.preference ?? "balanced";
      return Object.freeze({
        type: "selected" as const,
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
          result.consentByRoute.get(route.id) ??
          (result.chat.provider === route.provider ? "always" : "disabled"),
        crossProviderApprovalRequired:
          result.chat.provider !== route.provider && result.consentByRoute.get(route.id) === "ask",
        accountId: fact.accountId,
        executionMode: route.executionMode,
        ...optionalProperty("estimatedCostUsd", selectedScore.estimatedCostUsd),
        score: selectedScore.score,
        reasons: Object.freeze([
          `${preference} preference selected the highest eligible deterministic score`,
          ...fact.evidence,
        ]),
        ranking: result.ranking,
      });
    });

  return {
    select,
    rerouteAfterFailure: (decision, reason, request) =>
      Effect.gen(function* () {
        const result = yield* decisions({
          ...request,
          policy: { ...request.policy, mode: "auto" },
        });
        const alternatives: ImageRouteDecision[] = [];
        for (const candidate of result.ranking) {
          if (!candidate.eligible || candidate.routeId === decision.executorMediaRouteId) continue;
          const route = result.routeById.get(candidate.routeId)!;
          const fact = result.factById.get(candidate.routeId)!;
          alternatives.push(
            Object.freeze({
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
            }),
          );
        }
        return Object.freeze({
          type: "confirmation_required" as const,
          failedDecision: decision,
          reason,
          alternatives: Object.freeze(alternatives),
        });
      }),
  };
}

export class ImageRouter extends Context.Service<ImageRouter, ImageRouterApi>()(
  "memory-agent/ImageRouter",
) {
  static readonly layer = Layer.effect(
    ImageRouter,
    Effect.gen(function* () {
      return makeImageRouter(yield* RouteCatalog, yield* ImageRouteFacts);
    }),
  );
  static readonly consentLayer = Layer.effect(
    ImageRouter,
    Effect.gen(function* () {
      return makeImageRouter(
        yield* RouteCatalog,
        yield* ImageRouteFacts,
        yield* CrossProviderMediaConsent,
      );
    }),
  );
  static readonly layerFrom = (api: ImageRouterApi) => Layer.succeed(ImageRouter, api);
}
