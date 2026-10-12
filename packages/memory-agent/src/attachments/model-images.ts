import type { ChatMiddleware, ChatMiddlewareConfig, ModelMessage } from "@tanstack/ai";
import { Effect, MutableHashMap, Option } from "effect";
import type { AttachmentsApi } from "./attachments.ts";
import { attachmentIdOf } from "./urls.ts";

/** Image inlining must never replace the already-compacted provider view with transcript history. */
export const modelBoundMessages = (
  config: Pick<ChatMiddlewareConfig, "messages" | "providerMessages">,
): readonly ModelMessage[] => config.providerMessages ?? config.messages;

type ImageAttachments = Pick<AttachmentsApi, "get" | "forModelEffect" | "dataUrlEffect">;
/**
 * Stored transcripts use browser-safe relative attachment URLs. Providers cannot fetch those, so
 * only the model-bound copy gets the smaller stored image as provider-neutral inline data.
 * `run` is the owner's runtime: SDK middleware is a Promise boundary.
 */
export const modelImages = (
  attachments: ImageAttachments,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
): ChatMiddleware => ({
  name: "memory-agent/model-images",
  onConfig: (ctx, config) =>
    run(
      Effect.gen(function* () {
        if (ctx.phase === "init") return;
        let changed = false;
        const inlineImage = Effect.fn("modelImages.inlineImage")(function* (
          attachment: NonNullable<ReturnType<typeof attachments.get>>,
        ) {
          const image = yield* attachments.forModelEffect(attachment);
          const prefix = `data:${image.mimeType};base64,`;
          const dataUrl = yield* attachments.dataUrlEffect(image);
          return {
            type: "image" as const,
            source: {
              type: "data" as const,
              value: dataUrl.slice(prefix.length),
              mimeType: image.mimeType,
            },
          };
        });
        const inlineImages = MutableHashMap.empty<string, ReturnType<typeof inlineImage>>();
        const providerMessages = yield* Effect.forEach(
          modelBoundMessages(config),
          (message) =>
            Effect.gen(function* () {
              if (!Array.isArray(message.content)) return message;
              const content = yield* Effect.forEach(
                message.content,
                (part) =>
                  Effect.gen(function* () {
                    if (part.type !== "image" || part.source.type !== "url") return part;
                    const id = attachmentIdOf(part.source.value);
                    if (id === null) return part;
                    changed = true;
                    const attachment = attachments.get(id);
                    if (attachment === null)
                      return {
                        type: "text" as const,
                        content: "[Attached image is unavailable.]",
                      };
                    const known = Option.getOrUndefined(MutableHashMap.get(inlineImages, id));
                    if (known !== undefined) return yield* known;
                    const inline = yield* Effect.cachedWithTTL(inlineImage(attachment), 0);
                    MutableHashMap.set(inlineImages, id, inline);
                    return yield* inline;
                  }),
                { concurrency: "unbounded" },
              );
              return { ...message, content };
            }),
          { concurrency: "unbounded" },
        );
        return changed ? { providerMessages } : undefined;
      }),
    ),
});
