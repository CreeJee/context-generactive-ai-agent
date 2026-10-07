import { Function as EffectFunction } from "effect";
import type { MessagePart, UIMessage } from "@tanstack/ai";
import type { Attachment } from "../attachments/attachments.ts";
import { attachmentUrl } from "../attachments/urls.ts";
import type { Node } from "../memory/nodes.ts";

/**
 * Rebuilds the chat transcript of a session from its stored nodes, in the same shape useChat
 * streams: one user message per user turn (its text, then its images in attachment order), and
 * one assistant message per run holding its text, tool calls and tool results in order.
 */
export const sessionMessages: {
  (
    attachmentsOf: (nodeId: string) => readonly Attachment[],
  ): (nodes: readonly Node[]) => ReturnType<typeof sessionMessagesBody>;
} & typeof sessionMessagesBody = EffectFunction.dual(2, sessionMessagesBody);
function sessionMessagesBody(
  nodes: readonly Node[],
  attachmentsOf: (nodeId: string) => readonly Attachment[],
): UIMessage[] {
  const messages: UIMessage[] = [];
  let current: { runId: string | null; message: UIMessage } | null = null;

  for (const node of nodes) {
    if (node.kind === "user") {
      current = null;
      const images: MessagePart[] = attachmentsOf(node.id).map((attachment) => ({
        type: "image",
        source: { type: "url", value: attachmentUrl(attachment.id), mimeType: attachment.mimeType },
      }));
      messages.push({
        id: node.id,
        role: "user",
        parts: [
          ...(node.text.length > 0 ? [{ type: "text" as const, content: node.text }] : []),
          ...images,
        ],
        // The native SDK/fixture requires a JavaScript Date; this converts a timestamp, not an Effect clock read.
        createdAt: new Date(node.createdAt),
      });
      continue;
    }
    if (node.kind !== "assistant" && node.kind !== "tool_call" && node.kind !== "tool_result")
      continue;

    if (!(current !== null) || current.runId !== node.runId) {
      current = {
        runId: node.runId,
        // The native SDK/fixture requires a JavaScript Date; this converts a timestamp, not an Effect clock read.
        message: { id: node.id, role: "assistant", parts: [], createdAt: new Date(node.createdAt) },
      };
      messages.push(current.message);
    }
    const part = toPart(node);
    if (part !== null) current.message.parts.push(part);
  }
  return messages;
}

function toPart(node: Node): MessagePart | null {
  switch (node.kind) {
    case "assistant":
      return node.text.length > 0 ? { type: "text", content: node.text } : null;
    case "tool_call": {
      const name = node.detail.toolName ?? "";
      const prefix = `${name} `;
      return {
        type: "tool-call",
        id: node.detail.toolCallId ?? node.id,
        name,
        arguments: node.text.startsWith(prefix) ? node.text.slice(prefix.length) : node.text,
        state: "input-complete",
      };
    }
    case "tool_result":
      return {
        type: "tool-result",
        toolCallId: node.detail.toolCallId ?? node.id,
        content: node.text,
        state: node.detail.ok === false ? "error" : "complete",
      };
    default:
      return null;
  }
}
