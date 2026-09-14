import type { ChatMiddleware, ContentPart, ModelMessage } from "@tanstack/ai";
import { Context, Effect, Layer } from "effect";
import { Attachments } from "../attachments/attachments.ts";
import { attachmentUrl } from "../attachments/urls.ts";
import { ChatState } from "../chat-state/chat-state.ts";
import { CodexChat } from "../codex/chat.ts";
import { Nodes } from "../memory/nodes.ts";
import { MessageQueue } from "./queue.ts";
import type { QueuedMessage } from "./queue-state.ts";

export interface DeliveryBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
}

/** Custom stream event telling the page that queued messages reached the agent in this run. */
export const queueDeliveredEvent = "memory-agent.queue.delivered";

const make = Effect.gen(function* () {
  const queue = yield* MessageQueue;
  const codexChat = yield* CodexChat;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;
  const chatState = yield* ChatState;

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

  /** Every delivered message is evidence, like any user turn. */
  const record = (binding: DeliveryBinding, message: QueuedMessage) => {
    const node = nodes.append({
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      runId: binding.runId,
      kind: "user",
      text: message.text,
    });
    attachments.link(
      node.id,
      message.attachmentIds.flatMap((id) => {
        const attachment = attachments.get(id);
        return attachment ? [attachment] : [];
      }),
    );
  };

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
      Effect.tryPromise(() => codexChat.steer(binding.sessionId, toUserMessage(message))).pipe(
        Effect.map((outcome) => {
          if (outcome === "steered") {
            queue.markDelivered(message.id, "steer", binding.runId, false);
            record(binding, message);
          }
          return outcome;
        }),
      ),

    /**
     * Delivers waiting messages when a tool call returns: they go into the running codex turn and
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
            for (const message of queue.deliverable(binding.sessionId)) {
              const userMessage = toUserMessage(message);
              try {
                // With no live turn (a fresh codex thread follows), the conversation carries it.
                await codexChat.steer(binding.sessionId, userMessage);
              } catch {
                // Later messages stay behind it, so the order the user wrote in holds.
                queue.markFailed(message.id, "codex_refused");
                break;
              }
              added.push(userMessage);
              queue.markDelivered(message.id, "tool_boundary", binding.runId, true);
              record(binding, message);
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
export class QueueDelivery extends Context.Tag("memory-agent/QueueDelivery")<
  QueueDelivery,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(QueueDelivery, make);
}
