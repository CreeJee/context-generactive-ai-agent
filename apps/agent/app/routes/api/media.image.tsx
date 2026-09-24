import { Effect, Result, Schema } from "effect";
import { ActiveProvider, ImageMediaWorkflow, type ImageMediaRequest } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/media.image";

const CrossProviderApproval = Schema.Struct({
  runId: Schema.String,
  initiatorChatRouteId: Schema.TemplateLiteral([
    "chat:",
    Schema.Literals(["openai", "anthropic"]),
    ":",
    Schema.String,
  ]),
  executorMediaRouteId: Schema.String,
  capability: Schema.Literal("media.image.generate"),
});
const ImageMediaRequest = Schema.Struct({
  prompt: Schema.NonEmptyString,
  approved: Schema.Boolean,
  runId: Schema.optional(Schema.String),
  crossProviderApproval: Schema.optional(CrossProviderApproval),
  maximumEstimatedCostUsd: Schema.optional(Schema.Number),
});

/** POST /api/media/image — paid direct media workflow, deliberately outside chat tool context. */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, ImageMediaRequest);
  if (Result.isFailure(body))
    return Response.json({ error: "invalid_image_request" }, { status: 400 });

  const response = Effect.gen(function* () {
    const active = yield* ActiveProvider;
    const selected = yield* active.selected;
    if (selected === null)
      return Response.json(
        { error: "image_route_unavailable", reason: "no chat model selected" },
        { status: 422 },
      );
    const workflow = yield* ImageMediaWorkflow;
    let baseRequest: ImageMediaRequest = {
      initiatorChatRouteId: `chat:${selected.provider}:${selected.model}`,
      prompt: body.success.prompt,
      approved: body.success.approved,
      signal: request.signal,
    };
    if (body.success.runId !== undefined)
      baseRequest = { ...baseRequest, runId: body.success.runId };
    if (body.success.crossProviderApproval !== undefined)
      baseRequest = {
        ...baseRequest,
        crossProviderApproval: body.success.crossProviderApproval,
      };
    const mediaRequest: ImageMediaRequest =
      body.success.maximumEstimatedCostUsd === undefined
        ? baseRequest
        : { ...baseRequest, maximumEstimatedCostUsd: body.success.maximumEstimatedCostUsd };
    const asset = yield* workflow.generate(mediaRequest);
    return Response.json({
      ...asset,
      url: `/api/attachments/${encodeURIComponent(asset.attachment.id)}`,
    });
  }).pipe(
    Effect.catchTags({
      ImageMediaApprovalRequired: (failure) =>
        Effect.succeed(
          Response.json(
            {
              error: "image_approval_required",
              reason: failure.reason,
              approval: failure.approval,
            },
            { status: 409 },
          ),
        ),
      ImageMediaUnavailable: (failure) =>
        Effect.succeed(
          Response.json(
            { error: "image_route_unavailable", reason: failure.reason },
            { status: 422 },
          ),
        ),
      ImageMediaExecutionFailed: (failure) =>
        Effect.succeed(
          Response.json(
            { error: "image_execution_failed", reroute: failure.reroute },
            { status: 502 },
          ),
        ),
    }),
  );
  return agent.runPromise(response);
}
