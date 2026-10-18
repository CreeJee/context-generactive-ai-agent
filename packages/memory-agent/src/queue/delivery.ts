import { runNativeEffectWith } from "../runtime/native-effect.ts";
import type { ChatMiddleware, ContentPart, ModelMessage } from "@tanstack/ai";
import { Array as Arr, Context, Effect, Layer } from "effect";
import { Attachments } from "../attachments/attachments.ts";
import { attachmentUrl } from "../attachments/urls.ts";
import { Nodes } from "../memory/nodes.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { MessageQueue } from "./queue.ts";
import { queueDeliveredEvent, type QueuedMessage } from "./queue-state.ts";

export interface DeliveryBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export { queueDeliveredEvent };

const make = Effect.gen(function* () {
  const run = runNativeEffectWith(yield* Effect.context());
  const queue = yield* MessageQueue;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;
  const redactor = yield* SecretRedactor;

  /** The images a queued message still has; one deleted meanwhile is left out. */
  const imagesOf = (message: QueuedMessage) =>
    Effect.map(Effect.forEach(message.attachmentIds, attachments.get), (found) =>
      found.filter((attachment) => attachment !== null),
    );

  /** The queued message as the user turn the model receives. */
  const toUserMessage = (message: QueuedMessage) =>
    Effect.map(imagesOf(message), (images): ModelMessage => {
      if (images.length === 0) return { id: message.id, role: "user", content: message.text };
      const content: ContentPart[] = [
        ...(message.text.length > 0 ? [{ type: "text" as const, content: message.text }] : []),
        ...images.map((image) => ({
          type: "image" as const,
          source: {
            type: "url" as const,
            value: attachmentUrl(image.id),
            mimeType: image.mimeType,
          },
        })),
      ];
      return { id: message.id, role: "user", content };
    });

  /** Every delivered message is evidence, like any user turn, and kept without a pasted key. */
  const record = (binding: DeliveryBinding, message: QueuedMessage) =>
    Effect.gen(function* () {
      const kept = yield* redactor.redactText(message.text);
      const node = nodes.append({
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
        kind: "user",
        text: kept.text,
      });
      yield* attachments.link(node.id, yield* imagesOf(message));
    });

  return {
    toUserMessage,

    /**
     * Delivers waiting messages when a tool call returns: they join the request the model is about
     * to get, and the conversation, in queue order.
     */
    forRun(binding: DeliveryBinding): ChatMiddleware {
      return {
        name: "memory-agent/queue-delivery",
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        onConfig: (ctx, config) => {
          const deliver = (delivered: Arr.NonEmptyReadonlyArray<QueuedMessage>) =>
            Effect.forEach(
              delivered,
              (message) =>
                queue
                  .markDelivered(message.id, "tool_boundary", binding.runId)
                  .pipe(Effect.andThen(record(binding, message))),
              { discard: true },
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  ctx.emitCustomEvent(queueDeliveredEvent, {
                    ids: delivered.map((message) => message.id),
                  });
                }),
              ),
              Effect.andThen(Effect.forEach(delivered, toUserMessage)),
              Effect.map((messages) => ({ messages: [...config.messages, ...messages] })),
            );
          return run(
            (ctx.phase === "beforeModel" && config.messages.at(-1)?.role === "tool"
              ? queue.deliverable(binding.sessionId)
              : Effect.succeed<ReadonlyArray<QueuedMessage>>([])
            ).pipe(
              Effect.flatMap((found) =>
                Arr.isReadonlyArrayNonEmpty(found) ? deliver(found) : Effect.void,
              ),
            ),
          );
        },
      };
    },
  };
});

/** Gets queued follow-up messages to the agent at tool-call boundaries. */
export class QueueDelivery extends Context.Service<QueueDelivery, Effect.Success<typeof make>>()(
  "memory-agent/queue/delivery/QueueDelivery",
) {
  static readonly layer = Layer.effect(QueueDelivery, make);
}
