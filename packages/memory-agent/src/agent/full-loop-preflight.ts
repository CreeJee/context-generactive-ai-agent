import { convertSchemaToJsonSchema, type AnyTextAdapter } from "@tanstack/ai";
import type { ChatExecutionCapabilities, ChatExecutionTurn } from "./chat-execution.ts";

export const fullLoopHooks = new Set([
  "setup",
  "onInterruptBoundary",
  "onInterruptResolution",
  "onConfig",
  "onStart",
  "onIteration",
  "onShouldContinue",
  "onChunk",
  "onBeforeToolCall",
  "onAfterToolCall",
  "onToolPhaseComplete",
  "onUsage",
  "onFinish",
  "onAbort",
  "onError",
]);

/** Pure preparation check: call BEFORE binding/admission/user writes. This does
 * not dispatch SDK hooks or model/tool calls and grants no owner authority.
 * Prepare the complete owner capability set first; admission is a separate commit.
 */
export function preflightFullLoopExecution<TAdapter extends AnyTextAdapter>(
  turn: ChatExecutionTurn<TAdapter>,
  capabilities: ChatExecutionCapabilities<TAdapter>,
): void {
  if (turn.resume?.length) throw new Error("Worker interrupt continuation is not yet supported");
  const declared = new Set(capabilities.middleware.flatMap((mw) => [...(mw.provides ?? [])]));
  for (const mw of capabilities.middleware) {
    for (const required of mw.requires ?? []) {
      if (!declared.has(required))
        throw new Error(`Unprovided owner middleware capability: ${required.capabilityName}`);
    }
    for (const [key, value] of Object.entries(mw)) {
      if (
        ["name", "routedSubagentPersistence", "requires", "provides", "optionalRequires"].includes(
          key,
        )
      )
        continue;
      if (!fullLoopHooks.has(key) || !(value instanceof Function))
        throw new Error(`Unsupported worker middleware member: ${key}`);
    }
  }
  const definitions = (turn.interrupts ?? []).map((definition) => ({
    id: definition.id,
    payloadSchema: definition.payloadSchema?.["~standard"].jsonSchema.input({ target: "draft-07" }),
    responseSchema: definition.responseSchema?.["~standard"].jsonSchema.input({
      target: "draft-07",
    }),
  }));
  structuredClone({ ...turn, interrupts: definitions });
  structuredClone(
    capabilities.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ? convertSchemaToJsonSchema(tool.inputSchema) : undefined,
      outputSchema: tool.outputSchema ? convertSchemaToJsonSchema(tool.outputSchema) : undefined,
      needsApproval: tool.needsApproval,
    })),
  );
}
