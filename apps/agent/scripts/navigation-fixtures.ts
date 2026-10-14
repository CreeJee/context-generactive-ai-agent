import {
  createInterruptBinding,
  withInterruptBinding,
  INTERRUPT_PAYLOAD_METADATA_KEY,
} from "@tanstack/ai";
import { permissionReviewInterrupt } from "memory-agent/definitions";

/** Match the app's real approval schema without answering or executing the tool. */
export const navigationInterrupt = (threadId: string): ReturnType<typeof withInterruptBinding> => {
  const payload = {
    toolCallId: `nav-call-${threadId}`,
    toolName: "save_shell_skill",
    arguments: JSON.stringify({
      name: "nav-check",
      description: "Navigation fixture",
      script: `echo ${threadId}`,
    }),
    reason: `NAV-APPROVAL-${threadId}`,
  };
  const request = permissionReviewInterrupt.interrupt({
    key: `nav-${threadId}`,
    reason: "permission-review",
    message: payload.reason,
    payload,
  });
  const scope = { threadId, interruptedRunId: `nav-run-${threadId}`, generation: 1, batchIndex: 0 };
  const binding = createInterruptBinding(request, scope);
  const responseSchema = binding.descriptor.responseSchemaCanonicalJson;
  if (responseSchema === undefined) throw new Error("Navigation approval needs a response schema");
  return withInterruptBinding(
    {
      id: `nav-interrupt-${threadId}`,
      reason: request.reason,
      responseSchema: JSON.parse(responseSchema),
      metadata: { [INTERRUPT_PAYLOAD_METADATA_KEY]: payload },
    },
    { ...binding.descriptor, ...scope, interruptId: `nav-interrupt-${threadId}` },
  );
};
