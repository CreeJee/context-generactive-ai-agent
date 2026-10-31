import { Effect, Struct } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ActiveProvider, ImageMediaWorkflow } from "memory-agent";
import { AppApi } from "memory-agent/app-api";

/** The media group of `AppApi` (`/api/media/*`): paid generation, deliberately outside chat tools. */
export const MediaApiHandlers = HttpApiBuilder.group(
  AppApi,
  "media",
  Effect.fn(function* (handlers) {
    const active = yield* ActiveProvider;
    const workflow = yield* ImageMediaWorkflow;

    return handlers.handle("generateImage", ({ payload }) =>
      Effect.gen(function* () {
        const selected = yield* Effect.orDie(active.selected);
        if (selected === null)
          return yield* Effect.fail({
            error: "image_route_unavailable",
            reason: "no chat model selected",
          } as const);
        // The paid request stops when the page goes away and the handler is interrupted.
        const signal = yield* Effect.abortSignal;
        const asset = yield* workflow.generate({
          ...payload,
          initiatorChatRouteId: `chat:${selected.provider}:${selected.model}`,
          signal,
        });
        return { ...asset, url: `/api/attachments/${encodeURIComponent(asset.attachment.id)}` };
      }).pipe(
        Effect.scoped,
        Effect.catchTags({
          ImageMediaApprovalRequired: (failure) =>
            Effect.fail({
              error: "image_approval_required",
              ...Struct.pick(failure, ["reason", "approval"]),
            } as const),
          ImageMediaUnavailable: ({ reason }) =>
            Effect.fail({ error: "image_route_unavailable", reason } as const),
          ImageMediaExecutionFailed: () =>
            Effect.fail({ error: "image_execution_failed" } as const),
        }),
      ),
    );
  }),
);
