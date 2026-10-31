import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  CrossProviderMediaRunApproval,
  ImageApprovalReason,
  ImageMediaAsset,
} from "../../providers/image-media-contracts.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A direct image generation; it runs under the chat model the app has selected. */
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
const ApprovalRequired = refusalWith({
  reason: Schema.optionalKey(ImageApprovalReason),
  approval: Schema.optionalKey(CrossProviderMediaRunApproval),
})(409, ["image_approval_required"]);

/** No image route can run the request; `reason` says why. */
const RouteUnavailable = appRefusal(422, ["image_route_unavailable"]);

/** The image provider failed the run. */
const ExecutionFailed = appRefusal(502, ["image_execution_failed"]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const mediaRefusals = [ApprovalRequired, RouteUnavailable, ExecutionFailed];

/** Media the page asks for directly, outside the chat's tools (`/api/media/*`). */
export class MediaGroup extends HttpApiGroup.make("media")
  .add(
    /** A paid image generation; the page asks the user before it calls. */
    HttpApiEndpoint.post("generateImage", "/api/media/image", {
      payload: GenerateImage,
      success: GeneratedImage,
      error: [ApprovalRequired, RouteUnavailable, ExecutionFailed],
    }),
  )
  .middleware(SameSite) {}
