import type { PendingInterrupts } from "memory-agent/chat-api";

/** Match the app's real approval schema without answering or executing the tool. */
export const navigationInterrupt = (threadId: string): PendingInterrupts["pending"][number] => {
  const reason = `NAV-APPROVAL-${threadId}`;
  return {
    id: `nav-interrupt-${threadId}`,
    reason: "permission_review",
    message: reason,
    responseSchema: {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      additionalProperties: false,
    },
    metadata: {
      payload: {
        toolCallId: `nav-call-${threadId}`,
        toolName: "save_code_skill",
        arguments: JSON.stringify({
          name: "nav-check",
          description: "Navigation fixture",
          program: { runtime: "sh", script: `echo ${threadId}` },
        }),
        reason,
      },
    },
  };
};
