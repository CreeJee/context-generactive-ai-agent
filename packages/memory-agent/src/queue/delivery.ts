import { runNativeEffectWith } from "../runtime/native-effect.ts";
import type { ChatMiddleware } from "@tanstack/ai";
import { Array as Arr, Context, Effect, Layer } from "effect";
import { Attachments } from "../attachments/attachments.ts";
import { attachmentUrl } from "../attachments/urls.ts";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
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
    Effect.map(imagesOf(message), (images) => ({
      id: message.id,
      role: "user" as const,
      content: Arr.match(images, {
        onEmpty: () => message.text,
        onNonEmpty: (found) => [
          ...(message.text.length > 0 ? [{ type: "text" as const, content: message.text }] : []),
          ...found.map((image) => ({
            type: "image" as const,
            source: {
              type: "url" as const,
              value: attachmentUrl(image.id),
              mimeType: image.mimeType,
            },
          })),
        ],
      }),
    }));

  /** Every delivered message is evidence, like any user turn, and kept without a pasted key. */
  const record = (binding: DeliveryBinding, message: QueuedMessage) =>
    Effect.gen(function* () {
      const kept = yield* redactor.redactText(message.text);
      const node = yield* nodes.append({
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
        kind: "user",
        text: kept.text,
      });
      yield* attachments.link(node.id, yield* imagesOf(message));
    });

  /** Messages join only when the model is about to read a tool call's result. */
  const afterTool = (messages: ReadonlyArray<{ readonly role: StoredMessage["role"] }>) =>
    messages.at(-1)?.role === "tool";

  /**
   * Marks the waiting messages delivered, tells the page which, and gives them as user turns, in
   * queue order. Nothing joins when the step is not `due`.
   */
  const deliver = (
    binding: DeliveryBinding,
    due: boolean,
    announce: (ids: ReadonlyArray<string>) => Effect.Effect<void>,
  ) =>
    Effect.flatMap(
      due ? queue.deliverable(binding.sessionId) : Effect.succeed<ReadonlyArray<QueuedMessage>>([]),
      (found) =>
        Effect.forEach(
          found,
          (message) =>
            queue
              .markDelivered(message.id, "tool_boundary", binding.runId)
              .pipe(Effect.andThen(record(binding, message))),
          { discard: true },
        ).pipe(
          Effect.andThen(
            Effect.when(
              announce(found.map((message) => message.id)),
              Effect.succeed(found.length > 0),
            ),
          ),
          Effect.andThen(Effect.forEach(found, toUserMessage)),
        ),
    );

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
        onConfig: (ctx, config) =>
          run(
            deliver(binding, ctx.phase === "beforeModel" && afterTool(config.messages), (ids) =>
              Effect.sync(() => {
                ctx.emitCustomEvent(queueDeliveredEvent, { ids });
              }),
            ).pipe(
              Effect.map((messages) =>
                messages.length > 0 ? { messages: [...config.messages, ...messages] } : undefined,
              ),
            ),
          ),
      };
    },

    /** The same delivery for the Effect AI loop, before each model step. */
    hookForRun(binding: DeliveryBinding): RunHook {
      return {
        joining: (scope, conversation) =>
          deliver(binding, afterTool(conversation), (ids) =>
            scope.emit({ type: "CUSTOM", name: queueDeliveredEvent, value: { ids } }),
          ).pipe(Effect.mapError(asRunFailed)),
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
