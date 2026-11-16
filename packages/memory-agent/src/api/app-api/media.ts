import { Schema } from "effect";
import {
  CrossProviderMediaRunApproval,
  ImageApprovalReason,
  ImageMediaAsset,
} from "../../providers/image-media-contracts.ts";
import { appRefusalFields, refusalWith } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A direct image generation for a conversation; it runs under the conversation's chat model. */
export const GenerateImage = Schema.Struct({
  prompt: Schema.NonEmptyString,
  /** The user agreed to a paid generation. */
  approved: Schema.Boolean,
  runId: Schema.optionalKey(Schema.String),
  crossProviderApproval: Schema.optionalKey(CrossProviderMediaRunApproval),
  maximumEstimatedCostUsd: Schema.optionalKey(Schema.Finite),
});
export type GenerateImage = typeof GenerateImage.Type;

/** The generated image, with the URL the page shows it from. */
export const GeneratedImage = Schema.Struct({ ...ImageMediaAsset.fields, url: Schema.String });
export type GeneratedImage = typeof GeneratedImage.Type;

/** The user must approve first; a run on another provider carries the approval to give back. */
export const ApprovalRequired = refusalWith({
  reason: Schema.optionalKey(ImageApprovalReason),
  approval: Schema.optionalKey(CrossProviderMediaRunApproval),
})(409, ["image_approval_required"]);

/** No image route can run the request; `reason` says why. */
export const RouteUnavailable = appRefusal(422, ["image_route_unavailable"]);

/** The image provider failed the run. */
export const ExecutionFailed = appRefusal(502, ["image_execution_failed"]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const mediaRefusals = [ApprovalRequired, RouteUnavailable, ExecutionFailed];
