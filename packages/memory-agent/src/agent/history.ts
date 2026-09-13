import type { MessagePart, UIMessage } from "@tanstack/ai";
import type { Node } from "../memory/nodes.ts";

/**
 * Rebuilds the chat transcript of a session from its stored nodes, in the same shape useChat
 * streams: one user message per user turn, and one assistant message per run holding its text,
 * tool calls and tool results in order.
 */
export function sessionMessages(nodes: readonly Node[]): UIMessage[] {
  const messages: UIMessage[] = [];
  let current: { runId: string | null; message: UIMessage } | null = null;

  for (const node of nodes) {
    if (node.kind === "user") {
      current = null;
      messages.push({
        id: node.id,
        role: "user",
        parts: [{ type: "text", content: node.text }],
        createdAt: new Date(node.createdAt),
      });
      continue;
    }
    if (node.kind !== "assistant" && node.kind !== "tool_call" && node.kind !== "tool_result")
      continue;

    if (!current || current.runId !== node.runId) {
      current = {
        runId: node.runId,
        message: { id: node.id, role: "assistant", parts: [], createdAt: new Date(node.createdAt) },
      };
      messages.push(current.message);
    }
    const part = toPart(node);
    if (part) current.message.parts.push(part);
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
