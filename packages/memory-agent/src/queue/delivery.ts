import type { ChatMiddleware, ContentPart, ModelMessage } from "@tanstack/ai";
import { Context, Data, Effect, Layer } from "effect";
import { Attachments } from "../attachments/attachments.ts";
import { attachmentUrl } from "../attachments/urls.ts";
import { ChatState } from "../chat-state/chat-state.ts";
import { ActiveProvider } from "../providers/active-provider.ts";
import type { ModelSelection } from "../providers/contracts.ts";
import { Nodes } from "../memory/nodes.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { MessageQueue } from "./queue.ts";
import { queueDeliveredEvent, type QueuedMessage } from "./queue-state.ts";

export interface DeliveryBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly selection: ModelSelection;
}

export { queueDeliveredEvent };

export class QueueSteerFailed extends Data.TaggedError("QueueSteerFailed")<{
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

const make = Effect.gen(function* () {
  const run = Effect.runPromiseWith(yield* Effect.context());
  const queue = yield* MessageQueue;
  const active = yield* ActiveProvider;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;
  const chatState = yield* ChatState;
  const redactor = yield* SecretRedactor;

  /** The queued message as the user turn the model receives. */
  const toUserMessage = (message: QueuedMessage): ModelMessage => {
    const images = message.attachmentIds.flatMap((id) => {
      const attachment = attachments.get(id);
      return attachment ? [attachment] : [];
    });
    if (images.length === 0) return { role: "user", content: message.text };
    const content: ContentPart[] = [
      ...(message.text.length > 0 ? [{ type: "text" as const, content: message.text }] : []),
      ...images.map((image) => ({
        type: "image" as const,
        source: { type: "url" as const, value: attachmentUrl(image.id), mimeType: image.mimeType },
      })),
    ];
    return { role: "user", content };
  };

  /** Every delivered message is evidence, like any user turn, and kept without a pasted key. */
  const record = (binding: DeliveryBinding, message: QueuedMessage) =>
    Effect.map(redactor.redactText(message.text), (kept) => {
      const node = nodes.append({
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
        kind: "user",
        text: kept.text,
      });
      attachments.link(
        node.id,
        message.attachmentIds.flatMap((id) => {
          const attachment = attachments.get(id);
          return attachment ? [attachment] : [];
        }),
      );
    });

  /** Puts steered messages into the saved conversation, before the answer they arrived during. */
  const saveSteered = async (binding: DeliveryBinding) => {
    const steered = queue.steeredOutsideTranscript(binding.sessionId, binding.runId);
    if (steered.length === 0) return;
    const stored = await chatState.persistence.stores.messages.loadThread(binding.sessionId);
    const lastAnswer = stored.map((message) => message.role).lastIndexOf("assistant");
    const at = lastAnswer === -1 ? stored.length : lastAnswer;
    await chatState.persistence.stores.messages.saveThread(binding.sessionId, [
      ...stored.slice(0, at),
      ...steered.map(toUserMessage),
      ...stored.slice(at),
    ]);
    queue.markInTranscript(steered.map((message) => message.id));
  };

  return {
    toUserMessage,

    /**
     * Sends a message into the running turn at once (steering). The message is recorded now and
     * joins the saved conversation at the run's next boundary or end.
     */
    steer: (binding: DeliveryBinding, message: QueuedMessage) =>
      Effect.flatMap(active.runtime(binding.selection), (runtime) =>
        Effect.tryPromise({
          try: () => runtime.steer(binding.sessionId, toUserMessage(message)),
          catch: (cause) => new QueueSteerFailed({ sessionId: binding.sessionId, cause }),
        }),
      ).pipe(
        Effect.tap((outcome) => {
          if (outcome !== "steered") return Effect.void;
          queue.markDelivered(message.id, "steer", binding.runId, false);
          return record(binding, message);
        }),
      ),

    /**
     * Delivers waiting messages when a tool call returns: they go into the live provider turn and
     * into the conversation, in queue order. Steered messages not yet in the conversation are added
     * at the same boundary.
     */
    forRun(binding: DeliveryBinding): ChatMiddleware {
      return {
        name: "memory-agent/queue-delivery",
        async onConfig(ctx, config) {
          if (ctx.phase !== "beforeModel") return;
          const added: ModelMessage[] = [];
          const delivered: string[] = [];

          const steered = queue.steeredOutsideTranscript(binding.sessionId, binding.runId);
          added.push(...steered.map(toUserMessage));
          queue.markInTranscript(steered.map((message) => message.id));

          if (config.messages.at(-1)?.role === "tool") {
            const runtime = await run(active.runtime(binding.selection));
            for (const message of queue.deliverable(binding.sessionId)) {
              const userMessage = toUserMessage(message);
              try {
                // With no live turn, the next provider request carries it in the conversation.
                await runtime.steer(binding.sessionId, userMessage);
              } catch {
                // Later messages stay behind it, so the order the user wrote in holds.
                queue.markFailed(message.id, "steer_refused");
                break;
              }
              added.push(userMessage);
              queue.markDelivered(message.id, "tool_boundary", binding.runId, true);
              await run(record(binding, message));
              delivered.push(message.id);
            }
          }

          if (delivered.length > 0) ctx.emitCustomEvent(queueDeliveredEvent, { ids: delivered });
          if (added.length === 0) return;
          return { messages: [...config.messages, ...added] };
        },
        onFinish: () => saveSteered(binding),
        onAbort: () => saveSteered(binding),
        onError: () => saveSteered(binding),
      };
    },
  };
});

/** Gets queued follow-up messages to the agent: at tool-call boundaries, or steered at once. */
export class QueueDelivery extends Context.Service<QueueDelivery, Effect.Success<typeof make>>()(
  "memory-agent/QueueDelivery",
) {
  static readonly layer = Layer.effect(QueueDelivery, make);
}
