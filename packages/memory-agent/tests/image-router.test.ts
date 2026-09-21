import { Effect, Either } from "effect";
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
import { describe, expect, it } from "vite-plus/test";

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

async function router(
  factValues: readonly ImageRouteFact[] = facts,
  crossProviderConsent?: Parameters<typeof makeImageRouter>[2],
) {
  const source: RouteCatalogSource = {
    load: Effect.succeed({ chat: [chat], media: routes, execution: [] }),
  };
  const catalog = await Effect.runPromise(makeRouteCatalog(source, () => 1));
  await Effect.runPromise(catalog.refresh);
  return makeImageRouter(
    catalog,
    { forRoutes: () => Effect.succeed(factValues) },
    crossProviderConsent,
  );
}

describe("image router", () => {
  it("filters disabled cross-provider routes and marks ask routes for approval", async () => {
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
    const service = await router(facts, consent);
    const request = {
      initiatorChatRouteId: chat.id,
      intent,
      policy: { mode: "auto" as const },
    };
    expect(Either.isLeft(await Effect.runPromise(Effect.either(service.select(request))))).toBe(
      true,
    );
    mode = "ask";
    expect(await Effect.runPromise(service.select(request))).toMatchObject({
      initiatorProvider: "anthropic",
      provider: "openai",
      crossProvider: true,
      crossProviderConsentMode: "ask",
      crossProviderApprovalRequired: true,
    });
    mode = "always";
    expect(await Effect.runPromise(service.select(request))).toMatchObject({
      crossProviderConsentMode: "always",
      crossProviderApprovalRequired: false,
    });
  });

  it("is deterministic and defaults to balanced", async () => {
    const service = await router();
    const request = { initiatorChatRouteId: chat.id, intent, policy: { mode: "auto" as const } };
    const first = await Effect.runPromise(service.select(request));
    const second = await Effect.runPromise(service.select(request));
    expect(first).toEqual(second);
    expect(first.preference).toBe("balanced");
    expect(first.executorMediaRouteId).toBe(quality.id);
    expect(first.initiatorChatModel).toBe("claude-test");
    expect(first.executorMediaModel).toEqual({ type: "explicit", model: "gpt-image-2" });
  });

  it("changes route according to explicit quality, speed and cost preferences", async () => {
    const service = await router();
    const select = (preference: "quality" | "speed" | "cost") =>
      Effect.runPromise(
        service.select({
          initiatorChatRouteId: chat.id,
          intent,
          policy: { mode: "auto", preference },
        }),
      );
    expect((await select("quality")).executorMediaRouteId).toBe(quality.id);
    expect((await select("speed")).executorMediaRouteId).toBe(fast.id);
    expect((await select("cost")).executorMediaRouteId).toBe(cheap.id);
  });

  it("supports fixed override without bypassing route policy", async () => {
    const service = await router();
    const selected = await Effect.runPromise(
      service.select({
        initiatorChatRouteId: chat.id,
        intent,
        policy: { mode: "fixed", fixedRouteId: quality.id },
      }),
    );
    expect(selected.executorMediaRouteId).toBe(quality.id);
    const rejected = await Effect.runPromise(
      Effect.either(
        service.select({
          initiatorChatRouteId: chat.id,
          intent: { operation: "edit", sourceImageCount: 1, requiresMask: true },
          policy: { mode: "fixed", fixedRouteId: fast.id },
        }),
      ),
    );
    expect(Either.isLeft(rejected) && rejected.left._tag).toBe("FixedImageRouteRejected");
  });

  it("excludes unknown cost under a strict ceiling unless explicitly allowed", async () => {
    const strict = await Effect.runPromise(
      rankImageRoutes({
        routes,
        facts,
        intent,
        policy: { mode: "auto", preference: "speed", maximumEstimatedCostUsd: 1 },
      }),
    );
    expect(strict.find((score) => score.routeId === fast.id)).toMatchObject({ eligible: false });
    const allowed = await Effect.runPromise(
      rankImageRoutes({
        routes,
        facts,
        intent,
        policy: {
          mode: "auto",
          preference: "speed",
          maximumEstimatedCostUsd: 1,
          allowUnknownCost: true,
        },
      }),
    );
    expect(allowed.find((score) => score.routeId === fast.id)).toMatchObject({ eligible: true });
  });

  it("treats configured direct routes as attemptable without an operator verification flag", async () => {
    const service = await Effect.runPromise(
      Effect.provide(ImageRouteFacts, ImageRouteFacts.authenticatedRoutesLayer),
    );
    const routeFacts = await Effect.runPromise(
      service.forRoutes([
        quality,
        { ...cheap, authentication: { ...cheap.authentication, verified: false } },
      ]),
    );
    expect(routeFacts[0]).toMatchObject({
      routeId: quality.id,
      available: true,
      accountId: "openai-api-key",
    });
    expect(routeFacts[1]).toMatchObject({ routeId: cheap.id, available: false });
  });

  it("does not treat unverified account entitlement as implementation failure", async () => {
    const [score] = await Effect.runPromise(
      rankImageRoutes({
        routes: [{ ...quality, entitlement: { ...quality.entitlement, status: "unverified" } }],
        facts: [facts[0]!],
        intent,
        policy: { mode: "auto" },
      }),
    );
    expect(score?.eligible).toBe(true);
  });

  it("filters unauthenticated, disabled and unavailable routes", async () => {
    const disabled = media("gpt-image-2", { production: false });
    const ranking = await Effect.runPromise(
      rankImageRoutes({
        routes: [
          disabled,
          { ...cheap, authentication: { ...cheap.authentication, verified: false } },
          { ...fast, entitlement: { ...fast.entitlement, status: "unverified" } },
        ],
        facts: facts.map((fact) => ({ ...fact, available: false })),
        intent,
        policy: { mode: "auto" },
      }),
    );
    expect(ranking.every((score) => !score.eligible)).toBe(true);
  });

  it("returns typed failure with complete ranking when no route is eligible", async () => {
    const service = await router(facts.map((fact) => ({ ...fact, available: false })));
    const result = await Effect.runPromise(
      Effect.either(
        service.select({ initiatorChatRouteId: chat.id, intent, policy: { mode: "auto" } }),
      ),
    );
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "ImageRouteUnavailable",
      reasons: ["no eligible image route"],
    });
  });

  it("returns alternatives requiring confirmation instead of automatic fallback", async () => {
    const service = await router();
    const request = { initiatorChatRouteId: chat.id, intent, policy: { mode: "auto" as const } };
    const decision = await Effect.runPromise(service.select(request));
    const reroute = await Effect.runPromise(
      service.rerouteAfterFailure(decision, "provider overloaded", request),
    );
    expect(reroute.type).toBe("confirmation_required");
    expect(reroute.failedDecision).toBe(decision);
    expect(reroute.alternatives.length).toBeGreaterThan(0);
    expect(reroute.alternatives.every((candidate) => candidate.type === "selected")).toBe(true);
  });

  it("rejects malformed intent and scoring facts", async () => {
    const invalidIntent = await Effect.runPromise(
      Effect.either(
        rankImageRoutes({
          routes,
          facts,
          intent: { ...intent, sourceImageCount: -1 },
          policy: { mode: "auto" },
        }),
      ),
    );
    expect(Either.isLeft(invalidIntent) && invalidIntent.left._tag).toBe(
      "ImageRoutingInvalidRequest",
    );
    const invalidFact = await Effect.runPromise(
      Effect.either(
        rankImageRoutes({
          routes,
          facts: [{ ...facts[0]!, quality: 2 }],
          intent,
          policy: { mode: "auto" },
        }),
      ),
    );
    expect(Either.isLeft(invalidFact) && invalidFact.left._tag).toBe("ImageRoutingInvalidRequest");
  });
});
