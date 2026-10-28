import { Result, Function as EffectFunction } from "effect";
import {
  Config,
  ConfigProvider,
  Crypto,
  HashSet,
  Option,
  Context,
  Effect,
  Layer,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { optionalProperty } from "../optional-property.ts";
import { Attachments, type Attachment, type AttachmentsApi } from "../attachments/attachments.ts";
import {
  CrossProviderMediaConsent,
  type CrossProviderMediaConsentApi,
} from "./cross-provider-media-consent.ts";
import { ImageFeature, decideImageContext, type ImageFeatureApi } from "./image-feature.ts";
import {
  ImageRouter,
  ImageRerouteConfirmation,
  type ImageRouteDecision,
  type ImageRouterApi,
} from "./image-router.ts";
import { ProviderId } from "./contracts.ts";
import { ImageExecutorModel } from "./image-contracts.ts";
import { RouteCatalog, type RouteCatalogApi } from "./route-catalog.ts";

// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const stringifyJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const maximumGeneratedImageBytes = 25 * 1024 * 1024;
const supportedOutputTypes = HashSet.fromIterable(["image/png", "image/jpeg", "image/webp"]);
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

export class DirectImageExecutionFailed extends Schema.TaggedError<
  DirectImageExecutionFailed,
  { readonly brand: unique symbol }
>()("DirectImageExecutionFailed", {
  reason: Schema.Literals(["not_configured", "provider_rejected", "invalid_output", "network"]),
  /** The provider's HTTP status when it rejected the request. */
  status: Schema.optionalKey(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface DirectImageExecutorApi {
  readonly generate: (
    request: DirectImageExecutionRequest,
  ) => Effect.Effect<DirectImageExecutionResult, DirectImageExecutionFailed>;
}

export class DirectImageExecutor extends Context.Service<
  DirectImageExecutor,
  DirectImageExecutorApi
>()("memory-agent/providers/image-media/DirectImageExecutor") {
  static readonly layerFrom = (api: DirectImageExecutorApi) =>
    Layer.succeed(DirectImageExecutor, api);
  static readonly unavailableLayer = DirectImageExecutor.layerFrom({
    generate: () => Effect.fail(DirectImageExecutionFailed.make({ reason: "not_configured" })),
  });
  static readonly openAIEnvironmentLayer = Layer.effect(
    DirectImageExecutor,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return DirectImageExecutor.of({
        generate: ({ decision, prompt, signal }) =>
          Effect.gen(function* () {
            const key = yield* Config.option(Config.String("OPENAI_API_KEY"))
              .parse(ConfigProvider.fromEnv())
              .pipe(
                Effect.mapError((cause) =>
                  DirectImageExecutionFailed.make({ reason: "not_configured", cause }),
                ),
                Effect.flatMap((configured) =>
                  Effect.fromOption(configured, () =>
                    DirectImageExecutionFailed.make({ reason: "not_configured" }),
                  ),
                ),
              );
            const { model } = yield* Effect.succeed(decision.executorMediaModel).pipe(
              Effect.filterOrFail(ImageExecutorModel.$is("explicit"), () =>
                DirectImageExecutionFailed.make({ reason: "invalid_output" }),
              ),
            );
            const fetch = yield* FetchHttpClient.Fetch;
            const response = yield* client
              .execute(
                HttpClientRequest.post("https://api.openai.com/v1/images/generations").pipe(
                  HttpClientRequest.setHeaders({ authorization: `Bearer ${key}` }),
                  HttpClientRequest.bodyText(
                    stringifyJson({ model, prompt, output_format: "png" }),
                    "application/json",
                  ),
                ),
              )
              .pipe(
                Effect.provideService(FetchHttpClient.Fetch, (url, init) =>
                  Option.match(Option.fromUndefinedOr(signal), {
                    onNone: () => fetch(url, init),
                    onSome: (caller) =>
                      fetch(url, {
                        ...init,
                        signal: AbortSignal.any([
                          caller,
                          ...Option.toArray(Option.fromNullishOr(init?.signal)),
                        ]),
                      }),
                  }),
                ),
                Effect.mapError((cause) =>
                  DirectImageExecutionFailed.make({ reason: "network", cause }),
                ),
              );
            if (response.status < 200 || response.status >= 300)
              return yield* DirectImageExecutionFailed.make({
                reason: "provider_rejected",
                status: response.status,
              });
            const raw = yield* response.json.pipe(
              Effect.mapError((cause) =>
                DirectImageExecutionFailed.make({ reason: "network", cause }),
              ),
            );
            const value = yield* Schema.decodeUnknownEffect(OpenAIImageResponse)(raw).pipe(
              Effect.mapError((cause) =>
                DirectImageExecutionFailed.make({ reason: "network", cause }),
              ),
            );
            const encoded = yield* Effect.fromOption(
              Option.fromUndefinedOr(value.data[0]?.b64_json),
              () => DirectImageExecutionFailed.make({ reason: "invalid_output" }),
            );
            const result: DirectImageExecutionResult = {
              bytes: Uint8Array.from(Buffer.from(encoded, "base64")),
              contentType: "image/png",
            };
            const requestId = response.headers["x-request-id"];
            return requestId === undefined ? result : { ...result, providerRequestId: requestId };
          }).pipe(Effect.scoped),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

const RunApproval = Schema.Struct({
  runId: Schema.String,
  initiatorChatRouteId: Schema.TemplateLiteral(["chat:", ProviderId, ":", Schema.String]),
  executorMediaRouteId: Schema.String,
  capability: Schema.Literal("media.image.generate"),
});
export type CrossProviderMediaRunApproval = typeof RunApproval.Type;

export interface ImageMediaRequest {
  readonly initiatorChatRouteId: CrossProviderMediaRunApproval["initiatorChatRouteId"];
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

export class ImageMediaApprovalRequired extends Schema.TaggedError<
  ImageMediaApprovalRequired,
  { readonly brand: unique symbol }
>()("ImageMediaApprovalRequired", {
  reason: Schema.optionalKey(Schema.Literals(["paid_execution", "cross_provider"])),
  approval: Schema.optionalKey(RunApproval),
}) {}
export class ImageMediaUnavailable extends Schema.TaggedError<
  ImageMediaUnavailable,
  { readonly brand: unique symbol }
>()("ImageMediaUnavailable", {
  reason: Schema.Literals([
    "prompt_empty",
    "catalog_refresh_failed",
    "settings_unavailable",
    "no_direct_route",
    /** The image context gate refused the selected route. */
    "context_denied",
    "consent_service_unavailable",
    "consent_read_failed",
    "consent_disabled",
    /** Naming the run for a cross-provider approval failed. */
    "run_id_failed",
    "reroute_unavailable",
    "attachment_persistence_failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {}
const ImageRerouteConfirmationValue = Schema.declare(
  ImageRerouteConfirmation.$is("confirmation_required"),
);
export class ImageMediaExecutionFailed extends Schema.TaggedError<
  ImageMediaExecutionFailed,
  { readonly brand: unique symbol }
>()("ImageMediaExecutionFailed", {
  cause: DirectImageExecutionFailed,
  reroute: ImageRerouteConfirmationValue,
}) {}

export interface ImageMediaWorkflowApi {
  readonly generate: (
    request: ImageMediaRequest,
  ) => Effect.Effect<
    ImageMediaAsset,
    ImageMediaApprovalRequired | ImageMediaUnavailable | ImageMediaExecutionFailed
  >;
}

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function makeImageMediaWorkflow(options: {
  readonly feature: ImageFeatureApi;
  readonly router: ImageRouterApi;
  readonly executor: DirectImageExecutorApi;
  readonly attachments: Pick<AttachmentsApi, "save">;
  readonly crypto: Crypto.Crypto;
  readonly catalog?: Pick<RouteCatalogApi, "refresh"> | undefined;
  readonly crossProviderConsent?: CrossProviderMediaConsentApi | undefined;
}) {
  return makeImageMediaWorkflowBody(
    options.feature,
    options.router,
    options.executor,
    options.attachments,
    options.crypto,
    options.catalog,
    options.crossProviderConsent,
  );
}
function makeImageMediaWorkflowBody(
  feature: ImageFeatureApi,
  router: ImageRouterApi,
  executor: DirectImageExecutorApi,
  attachments: Pick<AttachmentsApi, "save">,
  crypto: Crypto.Crypto,
  catalog?: Pick<RouteCatalogApi, "refresh">,
  crossProviderConsent?: CrossProviderMediaConsentApi,
): ImageMediaWorkflowApi {
  return {
    generate: (request) =>
      Effect.gen(function* () {
        yield* Effect.when(
          Effect.fail(ImageMediaApprovalRequired.make({ reason: "paid_execution" })),
          Effect.succeed(!request.approved),
        );
        const prompt = request.prompt.trim();
        yield* Effect.when(
          Effect.fail(ImageMediaUnavailable.make({ reason: "prompt_empty" })),
          Effect.succeed(prompt.length === 0),
        );
        yield* Option.match(Option.fromUndefinedOr(catalog), {
          onNone: () => Effect.void,
          onSome: (routes) =>
            routes.refresh.pipe(
              Effect.mapError((cause) =>
                ImageMediaUnavailable.make({ reason: "catalog_refresh_failed", cause }),
              ),
            ),
        });
        const status = yield* feature.status.pipe(
          Effect.mapError((cause) =>
            ImageMediaUnavailable.make({ reason: "settings_unavailable", cause }),
          ),
        );
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
            Effect.mapError((cause) =>
              ImageMediaUnavailable.make({ reason: "no_direct_route", cause }),
            ),
          );
        const gate = decideImageContext({
          status,
          intent: { kind: "generate_image", source: "api" },
          route: decision,
        });
        yield* Effect.when(
          Effect.fail(ImageMediaUnavailable.make({ reason: "context_denied" })),
          Effect.succeed(!gate.directWorkflowAllowed),
        );
        const revalidateConsent = Effect.gen(function* () {
          const consents = yield* Effect.fromOption(
            Option.fromUndefinedOr(crossProviderConsent),
            () => ImageMediaUnavailable.make({ reason: "consent_service_unavailable" }),
          );
          const consent = yield* consents
            .decide({
              initiatorProvider: decision.initiatorProvider,
              executorProvider: decision.provider,
              capability: "media.image.generate",
            })
            .pipe(
              Effect.mapError((cause) =>
                ImageMediaUnavailable.make({ reason: "consent_read_failed", cause }),
              ),
            );
          yield* Effect.when(
            Effect.fail(ImageMediaUnavailable.make({ reason: "consent_disabled" })),
            Effect.succeed(consent.mode === "disabled"),
          );
          if (consent.mode === "always") return;
          const runId =
            request.runId ??
            (yield* crypto
              .randomUUIDv4()
              .pipe(
                Effect.mapError((cause) =>
                  ImageMediaUnavailable.make({ reason: "run_id_failed", cause }),
                ),
              ));
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
            return yield* ImageMediaApprovalRequired.make({
              reason: "cross_provider",
              approval: expected,
            });
        });
        // Only a pair across providers needs consent; one provider never asks.
        const revalidateCrossProviderConsent = Effect.when(
          revalidateConsent,
          Effect.succeed(decision.crossProvider),
        );
        const reroute = (reason: string) =>
          router
            .rerouteAfterFailure(decision, reason, {
              initiatorChatRouteId: request.initiatorChatRouteId,
              intent: { operation: "generate", sourceImageCount: 0, requiresMask: false },
              policy: { mode: "auto", preference: "balanced" },
            })
            .pipe(
              Effect.mapError((cause) =>
                ImageMediaUnavailable.make({ reason: "reroute_unavailable", cause }),
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
            Effect.catch((cause) =>
              Effect.flatMap(reroute(cause.reason), (confirmation) =>
                Effect.fail(ImageMediaExecutionFailed.make({ cause, reroute: confirmation })),
              ),
            ),
          );
        if (
          output.bytes.byteLength === 0 ||
          output.bytes.byteLength > maximumGeneratedImageBytes ||
          !HashSet.has(supportedOutputTypes, output.contentType)
        )
          return yield* ImageMediaExecutionFailed.make({
            cause: DirectImageExecutionFailed.make({ reason: "invalid_output" }),
            reroute: yield* reroute("invalid_output"),
          });
        const attachment = yield* attachments
          .save(output.bytes)
          .pipe(
            Effect.mapError((cause) =>
              ImageMediaUnavailable.make({ reason: "attachment_persistence_failed", cause }),
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
          ...optionalProperty("estimatedCostUsd", decision.estimatedCostUsd),
          ...optionalProperty("usage", output.usage),
          ...optionalProperty("providerRequestId", output.providerRequestId),
        };
      }),
  };
}

export class ImageMediaWorkflow extends Context.Service<
  ImageMediaWorkflow,
  ImageMediaWorkflowApi
>()("memory-agent/providers/image-media/ImageMediaWorkflow") {
  static readonly layer = Layer.effect(
    ImageMediaWorkflow,
    Effect.gen(function* () {
      return makeImageMediaWorkflow({
        feature: yield* ImageFeature,
        router: yield* ImageRouter,
        executor: yield* DirectImageExecutor,
        attachments: yield* Attachments,
        crypto: yield* Crypto.Crypto,
        catalog: yield* RouteCatalog,
        crossProviderConsent: yield* CrossProviderMediaConsent,
      });
    }),
  );
  static readonly layerFrom = (api: ImageMediaWorkflowApi) =>
    Layer.succeed(ImageMediaWorkflow, api);
}
