import { Context, Data, Effect, Layer, Schema } from "effect";
import { Attachments, type Attachment, type AttachmentsApi } from "../attachments/attachments.ts";
import {
  CrossProviderMediaConsent,
  type CrossProviderMediaConsentApi,
} from "./cross-provider-media-consent.ts";
import { ImageFeature, decideImageContext, type ImageFeatureApi } from "./image-feature.ts";
import {
  ImageRouter,
  type ImageRerouteConfirmation,
  type ImageRouteDecision,
  type ImageRouterApi,
} from "./image-router.ts";
import { RouteCatalog, type ChatRoute, type RouteCatalogApi } from "./route-catalog.ts";

const maximumGeneratedImageBytes = 25 * 1024 * 1024;
const supportedOutputTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const OpenAIImageResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.String })),
});

export interface DirectImageExecutionRequest {
  readonly decision: ImageRouteDecision;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface DirectImageExecutionResult {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg" | "image/webp";
  readonly providerRequestId?: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export class DirectImageExecutionFailed extends Data.TaggedError("DirectImageExecutionFailed")<{
  readonly reason: "not_configured" | "provider_rejected" | "invalid_output" | "network";
  readonly cause?: unknown;
}> {}

export interface DirectImageExecutorApi {
  readonly generate: (
    request: DirectImageExecutionRequest,
  ) => Effect.Effect<DirectImageExecutionResult, DirectImageExecutionFailed>;
}

export class DirectImageExecutor extends Context.Tag("memory-agent/DirectImageExecutor")<
  DirectImageExecutor,
  DirectImageExecutorApi
>() {
  static readonly layerFrom = (api: DirectImageExecutorApi) =>
    Layer.succeed(DirectImageExecutor, api);
  static readonly unavailableLayer = DirectImageExecutor.layerFrom({
    generate: () => Effect.fail(new DirectImageExecutionFailed({ reason: "not_configured" })),
  });
  static readonly openAIEnvironmentLayer = DirectImageExecutor.layerFrom({
    generate: ({ decision, prompt, signal }) => {
      const key = process.env.OPENAI_API_KEY;
      if (key === undefined)
        return Effect.fail(new DirectImageExecutionFailed({ reason: "not_configured" }));
      if (decision.executorMediaModel.type !== "explicit")
        return Effect.fail(new DirectImageExecutionFailed({ reason: "invalid_output" }));
      const model = decision.executorMediaModel.model;
      return Effect.tryPromise({
        try: async () => {
          const response = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({
              model,
              prompt,
              output_format: "png",
            }),
            signal,
          });
          if (!response.ok)
            throw new DirectImageExecutionFailed({
              reason: "provider_rejected",
              cause: { status: response.status },
            });
          const value = await Schema.decodeUnknownPromise(OpenAIImageResponse)(
            await response.json(),
          );
          const encoded = value.data[0]?.b64_json;
          if (encoded === undefined)
            throw new DirectImageExecutionFailed({ reason: "invalid_output" });
          const result: DirectImageExecutionResult = {
            bytes: Uint8Array.from(Buffer.from(encoded, "base64")),
            contentType: "image/png",
          };
          const requestId = response.headers.get("x-request-id");
          return requestId === null ? result : { ...result, providerRequestId: requestId };
        },
        catch: (cause) =>
          cause instanceof DirectImageExecutionFailed
            ? cause
            : new DirectImageExecutionFailed({ reason: "network", cause }),
      });
    },
  });
}

export interface CrossProviderMediaRunApproval {
  readonly runId: string;
  readonly initiatorChatRouteId: ChatRoute["id"];
  readonly executorMediaRouteId: string;
  readonly capability: "media.image.generate";
}

export interface ImageMediaRequest {
  readonly initiatorChatRouteId: ChatRoute["id"];
  readonly prompt: string;
  readonly approved: boolean;
  readonly runId?: string;
  readonly crossProviderApproval?: CrossProviderMediaRunApproval;
  readonly maximumEstimatedCostUsd?: number;
  readonly signal?: AbortSignal;
}

export interface ImageMediaAsset {
  readonly attachment: Attachment;
  readonly initiatorChatModel: string;
  readonly executorMediaRouteId: string;
  readonly executorMediaModel: ImageRouteDecision["executorMediaModel"];
  readonly provider: "openai";
  readonly accountId: string;
  readonly executionMode: "direct_adapter";
  readonly estimatedCostUsd?: number;
  readonly usage?: Readonly<Record<string, number>>;
  readonly providerRequestId?: string;
}

export class ImageMediaApprovalRequired extends Data.TaggedError("ImageMediaApprovalRequired")<{
  readonly reason?: "paid_execution" | "cross_provider";
  readonly approval?: CrossProviderMediaRunApproval;
}> {}
export class ImageMediaUnavailable extends Data.TaggedError("ImageMediaUnavailable")<{
  readonly reason: string;
}> {}
export class ImageMediaExecutionFailed extends Data.TaggedError("ImageMediaExecutionFailed")<{
  readonly cause: DirectImageExecutionFailed;
  readonly reroute: ImageRerouteConfirmation;
}> {}

export interface ImageMediaWorkflowApi {
  readonly generate: (
    request: ImageMediaRequest,
  ) => Effect.Effect<
    ImageMediaAsset,
    ImageMediaApprovalRequired | ImageMediaUnavailable | ImageMediaExecutionFailed
  >;
}

export function makeImageMediaWorkflow(
  feature: ImageFeatureApi,
  router: ImageRouterApi,
  executor: DirectImageExecutorApi,
  attachments: Pick<AttachmentsApi, "save">,
  catalog?: Pick<RouteCatalogApi, "refresh">,
  crossProviderConsent?: CrossProviderMediaConsentApi,
): ImageMediaWorkflowApi {
  return {
    generate: (request) =>
      Effect.gen(function* () {
        if (!request.approved)
          return yield* new ImageMediaApprovalRequired({ reason: "paid_execution" });
        const prompt = request.prompt.trim();
        if (prompt.length === 0)
          return yield* new ImageMediaUnavailable({ reason: "prompt is empty" });
        if (catalog)
          yield* catalog.refresh.pipe(
            Effect.mapError(
              () => new ImageMediaUnavailable({ reason: "route catalog refresh failed" }),
            ),
          );
        const status = yield* feature.status;
        const policy =
          request.maximumEstimatedCostUsd === undefined
            ? {
                mode: "auto" as const,
                preference: "balanced" as const,
                allowedExecutionModes: ["direct_adapter"] as const,
              }
            : {
                mode: "auto" as const,
                preference: "balanced" as const,
                allowedExecutionModes: ["direct_adapter"] as const,
                maximumEstimatedCostUsd: request.maximumEstimatedCostUsd,
              };
        const decision = yield* router
          .select({
            initiatorChatRouteId: request.initiatorChatRouteId,
            intent: { operation: "generate", sourceImageCount: 0, requiresMask: false },
            policy,
          })
          .pipe(
            Effect.mapError(() => new ImageMediaUnavailable({ reason: "no direct image route" })),
          );
        const gate = decideImageContext({
          status,
          intent: { kind: "generate_image", source: "api" },
          route: decision,
        });
        if (!gate.directWorkflowAllowed)
          return yield* new ImageMediaUnavailable({ reason: gate.reasons.join("; ") });
        const revalidateCrossProviderConsent = Effect.gen(function* () {
          if (!decision.crossProvider) return;
          if (crossProviderConsent === undefined)
            return yield* new ImageMediaUnavailable({
              reason: "cross-provider consent service unavailable",
            });
          const consent = yield* crossProviderConsent
            .decide({
              initiatorProvider: decision.initiatorProvider,
              executorProvider: decision.provider,
              capability: "media.image.generate",
            })
            .pipe(
              Effect.mapError(
                () => new ImageMediaUnavailable({ reason: "cross-provider consent read failed" }),
              ),
            );
          if (consent.mode === "disabled")
            return yield* new ImageMediaUnavailable({ reason: "cross-provider consent disabled" });
          if (consent.mode === "always") return;
          const runId = request.runId ?? crypto.randomUUID();
          const expected: CrossProviderMediaRunApproval = {
            runId,
            initiatorChatRouteId: decision.initiatorChatRouteId,
            executorMediaRouteId: decision.executorMediaRouteId,
            capability: "media.image.generate",
          };
          const approval = request.crossProviderApproval;
          if (
            approval === undefined ||
            request.runId === undefined ||
            approval.runId !== expected.runId ||
            approval.initiatorChatRouteId !== expected.initiatorChatRouteId ||
            approval.executorMediaRouteId !== expected.executorMediaRouteId ||
            approval.capability !== expected.capability
          )
            return yield* new ImageMediaApprovalRequired({
              reason: "cross_provider",
              approval: expected,
            });
        });
        const reroute = (reason: string) =>
          router
            .rerouteAfterFailure(decision, reason, {
              initiatorChatRouteId: request.initiatorChatRouteId,
              intent: { operation: "generate", sourceImageCount: 0, requiresMask: false },
              policy: { mode: "auto", preference: "balanced" },
            })
            .pipe(
              Effect.mapError(
                () => new ImageMediaUnavailable({ reason: "reroute alternatives unavailable" }),
              ),
            );

        const executionRequest: DirectImageExecutionRequest =
          request.signal === undefined
            ? { decision, prompt }
            : { decision, prompt, signal: request.signal };
        // Re-read consent immediately before the provider side effect. A revoked or changed
        // pair cannot reuse a route decision or approval obtained earlier in the request.
        yield* revalidateCrossProviderConsent;
        const output = yield* executor
          .generate(executionRequest)
          .pipe(
            Effect.catchAll((cause) =>
              Effect.flatMap(reroute(cause.reason), (confirmation) =>
                Effect.fail(new ImageMediaExecutionFailed({ cause, reroute: confirmation })),
              ),
            ),
          );
        if (
          output.bytes.byteLength === 0 ||
          output.bytes.byteLength > maximumGeneratedImageBytes ||
          !supportedOutputTypes.has(output.contentType)
        )
          return yield* new ImageMediaExecutionFailed({
            cause: new DirectImageExecutionFailed({ reason: "invalid_output" }),
            reroute: yield* reroute("invalid_output"),
          });
        const attachment = yield* attachments
          .save(output.bytes)
          .pipe(
            Effect.mapError(
              () => new ImageMediaUnavailable({ reason: "attachment persistence failed" }),
            ),
          );
        return {
          attachment,
          initiatorChatModel: decision.initiatorChatModel,
          executorMediaRouteId: decision.executorMediaRouteId,
          executorMediaModel: decision.executorMediaModel,
          provider: decision.provider,
          accountId: decision.accountId,
          executionMode: "direct_adapter",
          estimatedCostUsd: decision.estimatedCostUsd,
          usage: output.usage,
          providerRequestId: output.providerRequestId,
        };
      }),
  };
}

export class ImageMediaWorkflow extends Context.Tag("memory-agent/ImageMediaWorkflow")<
  ImageMediaWorkflow,
  ImageMediaWorkflowApi
>() {
  static readonly layer = Layer.effect(
    ImageMediaWorkflow,
    Effect.gen(function* () {
      return makeImageMediaWorkflow(
        yield* ImageFeature,
        yield* ImageRouter,
        yield* DirectImageExecutor,
        yield* Attachments,
        yield* RouteCatalog,
        yield* CrossProviderMediaConsent,
      );
    }),
  );
  static readonly layerFrom = (api: ImageMediaWorkflowApi) =>
    Layer.succeed(ImageMediaWorkflow, api);
}
