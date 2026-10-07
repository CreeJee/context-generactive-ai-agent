import { Layer } from "effect";
import { it as effectTest } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  ImageRouteFacts,
  makeImageRouter,
  makeRouteCatalog,
  rankImageRoutes,
  type ChatRoute,
  type ImageRouteFact,
  type MediaRoute,
  type RouteCatalogSource,
} from "memory-agent";
import { describe, expect } from "vite-plus/test";

const chat: ChatRoute = {
  type: "chat",
  id: "chat:anthropic:claude-test",
  provider: "anthropic",
  model: "claude-test",
  displayName: "Claude Test",
  capabilities: { inputModalities: ["text", "image"], toolCalling: true, reasoning: true },
  reasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
  authentication: { mechanism: "subscription_oauth", status: "signed-in", verified: true },
  entitlement: { status: "verified", source: "provider_model_catalog", detail: "fixture" },
};

function media(
  model: "gpt-image-2" | "gpt-image-1-mini" | "dall-e-3",
  options: { readonly edit?: boolean; readonly production?: boolean } = {},
): MediaRoute {
  const edit = options.edit ?? true;
  return {
    type: "media",
    id: `media:openai:direct_adapter:${model}`,
    provider: "openai",
    executionMode: "direct_adapter",
    executorModel: { type: "explicit", model },
    operations: edit ? ["generate", "edit"] : ["generate"],
    authentication: { mechanism: "openai_api_key", status: "signed-in", verified: true },
    entitlement: { status: "verified", source: "account_capability", detail: "fixture" },
    billingAttribution: "executor_model",
    contract: {
      id: `openai:direct_adapter:${model}`,
      provider: "openai",
      executionMode: "direct_adapter",
      executorModel: { type: "explicit", model },
      verification: "verified",
      productionEnabled: options.production ?? true,
      authentication: "openai_api_key",
      billingAttribution: "executor_model",
      operations: edit ? ["generate", "edit"] : ["generate"],
      input: {
        text: true,
        images: edit,
        maximumSourceImages: edit ? 16 : 0,
        mask: edit,
        remoteUrlFetch: edit ? "disabled_by_default" : "not_applicable",
      },
      output: {
        sources: ["url", "base64"],
        mime: "provider_option_or_detect_bytes",
        temporaryUrlPossible: true,
        persistenceRequired: true,
      },
      usage: {
        tokenUsagePossible: true,
        rawProviderUsagePreserved: false,
        costKnownBeforeExecution: false,
      },
      cancellation: "request_abort_signal",
      evidence: ["fixture"],
    },
  };
}

const quality = media("gpt-image-2");
const cheap = media("gpt-image-1-mini");
const fast = media("dall-e-3", { edit: false });
const routes = [quality, cheap, fast] as const;
const facts: readonly ImageRouteFact[] = [
  {
    routeId: quality.id,
    accountId: "account-1",
    available: true,
    quality: 1,
    speed: 0.4,
    estimatedCostUsd: 0.12,
    evidence: ["quality fixture"],
  },
  {
    routeId: cheap.id,
    accountId: "account-1",
    available: true,
    quality: 0.65,
    speed: 0.7,
    estimatedCostUsd: 0.02,
    evidence: ["cost fixture"],
  },
  {
    routeId: fast.id,
    accountId: "account-1",
    available: true,
    quality: 0.5,
    speed: 1,
    evidence: ["unknown cost fixture"],
  },
];
const intent = { operation: "generate" as const, sourceImageCount: 0, requiresMask: false };

const router = Effect.fnUntraced(function* (
  factValues: readonly ImageRouteFact[] = facts,
  crossProviderConsent?: Parameters<typeof makeImageRouter>[2],
) {
  const source: RouteCatalogSource = {
    load: Effect.succeed({ chat: [chat], media: routes, execution: [] }),
  };
  const catalog = yield* makeRouteCatalog(source, () => 1);
  yield* catalog.refresh;
  return makeImageRouter(
    catalog,
    { forRoutes: () => Effect.succeed(factValues) },
    crossProviderConsent,
  );
});

describe("image router", () => {
  effectTest.effect(
    "filters disabled cross-provider routes and marks ask routes for approval",
    () =>
      Effect.gen(function* () {
        let mode: "disabled" | "ask" | "always" = "disabled";
        const consent: NonNullable<Parameters<typeof makeImageRouter>[2]> = {
          read: Effect.succeed({ version: 1, pairs: {} }),
          decide: (pair) =>
            Effect.succeed({
              ...pair,
              crossProvider: true,
              mode,
              allowedWithoutPrompt: mode === "always",
              requiresApproval: mode === "ask",
              reasons: [],
              settingsVersion: 1,
            }),
          set: () => Effect.die("unused"),
        };
        const service = yield* router(facts, consent);
        const request = {
          initiatorChatRouteId: chat.id,
          intent,
          policy: { mode: "auto" as const },
        };
        expect(Result.isFailure(yield* Effect.result(service.select(request)))).toBe(true);
        mode = "ask";
        expect(yield* service.select(request)).toMatchObject({
          initiatorProvider: "anthropic",
          provider: "openai",
          crossProvider: true,
          crossProviderConsentMode: "ask",
          crossProviderApprovalRequired: true,
        });
        mode = "always";
        expect(yield* service.select(request)).toMatchObject({
          crossProviderConsentMode: "always",
          crossProviderApprovalRequired: false,
        });
      }),
  );

  effectTest.effect("is deterministic and defaults to balanced", () =>
    Effect.gen(function* () {
      const service = yield* router();
      const request = { initiatorChatRouteId: chat.id, intent, policy: { mode: "auto" as const } };
      const first = yield* service.select(request);
      const second = yield* service.select(request);
      expect(first).toEqual(second);
      expect(first.preference).toBe("balanced");
      expect(first.executorMediaRouteId).toBe(quality.id);
      expect(first.initiatorChatModel).toBe("claude-test");
      expect(first.executorMediaModel).toEqual({ type: "explicit", model: "gpt-image-2" });
    }),
  );

  effectTest.effect("changes route according to explicit quality, speed and cost preferences", () =>
    Effect.gen(function* () {
      const service = yield* router();
      const select = (preference: "quality" | "speed" | "cost") =>
        service.select({
          initiatorChatRouteId: chat.id,
          intent,
          policy: { mode: "auto", preference },
        });
      expect((yield* select("quality")).executorMediaRouteId).toBe(quality.id);
      expect((yield* select("speed")).executorMediaRouteId).toBe(fast.id);
      expect((yield* select("cost")).executorMediaRouteId).toBe(cheap.id);
    }),
  );

  effectTest.effect("supports fixed override without bypassing route policy", () =>
    Effect.gen(function* () {
      const service = yield* router();
      const selected = yield* service.select({
        initiatorChatRouteId: chat.id,
        intent,
        policy: { mode: "fixed", fixedRouteId: quality.id },
      });
      expect(selected.executorMediaRouteId).toBe(quality.id);
      const rejected = yield* Effect.result(
        service.select({
          initiatorChatRouteId: chat.id,
          intent: { operation: "edit", sourceImageCount: 1, requiresMask: true },
          policy: { mode: "fixed", fixedRouteId: fast.id },
        }),
      );
      expect(Result.isFailure(rejected) && rejected.failure._tag).toBe("FixedImageRouteRejected");
    }),
  );

  effectTest.effect("excludes unknown cost under a strict ceiling unless explicitly allowed", () =>
    Effect.gen(function* () {
      const strict = yield* rankImageRoutes({
        routes,
        facts,
        intent,
        policy: { mode: "auto", preference: "speed", maximumEstimatedCostUsd: 1 },
      });
      expect(strict.find((score) => score.routeId === fast.id)).toMatchObject({ eligible: false });
      const allowed = yield* rankImageRoutes({
        routes,
        facts,
        intent,
        policy: {
          mode: "auto",
          preference: "speed",
          maximumEstimatedCostUsd: 1,
          allowUnknownCost: true,
        },
      });
      expect(allowed.find((score) => score.routeId === fast.id)).toMatchObject({ eligible: true });
    }),
  );

  effectTest.effect(
    "treats configured direct routes as attemptable without an operator verification flag",
    () =>
      Effect.gen(function* () {
        const service = yield* Effect.scoped(
          Effect.flatMap(Layer.build(ImageRouteFacts.authenticatedRoutesLayer), (services) =>
            Effect.provideContext(ImageRouteFacts, services),
          ),
        );
        const routeFacts = yield* service.forRoutes([
          quality,
          { ...cheap, authentication: { ...cheap.authentication, verified: false } },
        ]);
        expect(routeFacts[0]).toMatchObject({
          routeId: quality.id,
          available: true,
          accountId: "openai-api-key",
        });
        expect(routeFacts[1]).toMatchObject({ routeId: cheap.id, available: false });
      }),
  );

  effectTest.effect("does not treat unverified account entitlement as implementation failure", () =>
    Effect.gen(function* () {
      const [score] = yield* rankImageRoutes({
        routes: [{ ...quality, entitlement: { ...quality.entitlement, status: "unverified" } }],
        facts: [facts[0]!],
        intent,
        policy: { mode: "auto" },
      });
      expect(score?.eligible).toBe(true);
    }),
  );

  effectTest.effect("filters unauthenticated, disabled and unavailable routes", () =>
    Effect.gen(function* () {
      const disabled = media("gpt-image-2", { production: false });
      const ranking = yield* rankImageRoutes({
        routes: [
          disabled,
          { ...cheap, authentication: { ...cheap.authentication, verified: false } },
          { ...fast, entitlement: { ...fast.entitlement, status: "unverified" } },
        ],
        facts: facts.map((fact) => ({ ...fact, available: false })),
        intent,
        policy: { mode: "auto" },
      });
      expect(ranking.every((score) => !score.eligible)).toBe(true);
    }),
  );

  effectTest.effect("returns typed failure with complete ranking when no route is eligible", () =>
    Effect.gen(function* () {
      const service = yield* router(facts.map((fact) => ({ ...fact, available: false })));
      const result = yield* Effect.result(
        service.select({ initiatorChatRouteId: chat.id, intent, policy: { mode: "auto" } }),
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "ImageRouteUnavailable",
        reasons: ["no eligible image route"],
      });
    }),
  );

  effectTest.effect(
    "returns alternatives requiring confirmation instead of automatic fallback",
    () =>
      Effect.gen(function* () {
        const service = yield* router();
        const request = {
          initiatorChatRouteId: chat.id,
          intent,
          policy: { mode: "auto" as const },
        };
        const decision = yield* service.select(request);
        const reroute = yield* service.rerouteAfterFailure(
          decision,
          "provider overloaded",
          request,
        );
        expect(reroute.type).toBe("confirmation_required");
        expect(reroute.failedDecision).toBe(decision);
        expect(reroute.alternatives.length).toBeGreaterThan(0);
        expect(reroute.alternatives.every((candidate) => candidate.type === "selected")).toBe(true);
      }),
  );

  effectTest.effect("rejects malformed intent and scoring facts", () =>
    Effect.gen(function* () {
      const invalidIntent = yield* Effect.result(
        rankImageRoutes({
          routes,
          facts,
          intent: { ...intent, sourceImageCount: -1 },
          policy: { mode: "auto" },
        }),
      );
      expect(Result.isFailure(invalidIntent) && invalidIntent.failure._tag).toBe(
        "ImageRoutingInvalidRequest",
      );
      const invalidFact = yield* Effect.result(
        rankImageRoutes({
          routes,
          facts: [{ ...facts[0]!, quality: 2 }],
          intent,
          policy: { mode: "auto" },
        }),
      );
      expect(Result.isFailure(invalidFact) && invalidFact.failure._tag).toBe(
        "ImageRoutingInvalidRequest",
      );
    }),
  );
});
