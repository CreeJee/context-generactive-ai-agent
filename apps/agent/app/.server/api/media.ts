import { Effect, Struct } from "effect";
import type { ImageMediaApprovalRequired, ImageMediaUnavailable } from "memory-agent";

/** What an image generation's failures answer, for a conversation's image route. */
export const imageGenerationRefusals = {
  ImageMediaApprovalRequired: (failure: ImageMediaApprovalRequired) =>
    Effect.fail({
      error: "image_approval_required",
      ...Struct.pick(failure, ["reason", "approval"]),
    } as const),
  ImageMediaUnavailable: ({ reason }: ImageMediaUnavailable) =>
    Effect.fail({ error: "image_route_unavailable", reason } as const),
  ImageMediaExecutionFailed: () => Effect.fail({ error: "image_execution_failed" } as const),
};
