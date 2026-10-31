import { Schema } from "effect";
import { Attachment } from "../attachments/contracts.ts";
import { ProviderId } from "./contracts.ts";
import { ImageExecutorModelSchema } from "./image-contracts.ts";

/**
 * What a direct image generation asks and gives, as the page and the server see it. This module
 * imports no server code, so the browser bundle can use it.
 */

/** The user's approval of one run on another provider's media route. */
export const CrossProviderMediaRunApproval = Schema.Struct({
  runId: Schema.String,
  initiatorChatRouteId: Schema.TemplateLiteral(["chat:", ProviderId, ":", Schema.String]),
  executorMediaRouteId: Schema.String,
  capability: Schema.Literal("media.image.generate"),
});
export type CrossProviderMediaRunApproval = typeof CrossProviderMediaRunApproval.Type;

/** What the user must approve first: a paid run, or a run on another provider. */
export const ImageApprovalReason = Schema.Literals(["paid_execution", "cross_provider"]);
export type ImageApprovalReason = typeof ImageApprovalReason.Type;

/** A generated image, stored as an attachment, and the route that made it. */
export const ImageMediaAsset = Schema.Struct({
  attachment: Attachment,
  initiatorChatModel: Schema.String,
  executorMediaRouteId: Schema.String,
  executorMediaModel: ImageExecutorModelSchema,
  provider: Schema.Literal("openai"),
  accountId: Schema.String,
  executionMode: Schema.Literal("direct_adapter"),
  estimatedCostUsd: Schema.optionalKey(Schema.Finite),
  usage: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  providerRequestId: Schema.optionalKey(Schema.String),
});
export type ImageMediaAsset = typeof ImageMediaAsset.Type;
