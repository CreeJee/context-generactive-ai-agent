import {
  isStandardSchema,
  parseWithStandardSchema,
  type AnyServerTool,
  type ChatMiddleware,
  type ToolExecutionContext,
} from "@tanstack/ai";

/** Tools that only read: running several of them at once cannot change what another sees. */
export const readOnlyToolNames: ReadonlySet<string> = new Set([
  "find_memory",
  "read_evidence",
  "trace_evidence",
  "list_files",
  "search_files",
  "read_file",
  "list_outside_files",
  "read_outside_file",
  "search_outside_file",
  "read_skill",
  "kagi_search",
  "kagi_extract",
]);

export interface ParallelReads {
  /** The same tools; read-only ones pick up a result that was started early. */
  readonly tools: AnyServerTool[];
  readonly middleware: ChatMiddleware;
}

/**
 * TanStack runs the tool calls of one model step one after another. When a step starts with several
 * read-only calls, this starts all of them at the first one, and each call then just takes its own
 * result, so reads run at once while results still come back in call order.
 *
 * Only the read-only calls before the first other call are started early: a read that follows a
 * write in the same step still runs after that write.
 */
export function parallelReads(tools: readonly AnyServerTool[], signal: AbortSignal): ParallelReads {
  const started = new Map<string, Promise<unknown>>();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const startEarly = (toolCallId: string, tool: AnyServerTool, argumentsJson: string) => {
    const execute = tool.execute;
    if (!execute || started.has(toolCallId)) return;
    // Parsed and validated as the engine will; on any problem the call simply runs in order, where
    // the engine reports it.
    let value: unknown;
    try {
      const parsed: unknown = JSON.parse(argumentsJson.trim() || "{}");
      value = isStandardSchema(tool.inputSchema)
        ? parseWithStandardSchema(tool.inputSchema, parsed)
        : parsed;
    } catch {
      return;
    }
    const run = () => {
      const context: ToolExecutionContext = {
        toolCallId,
        abortSignal: signal,
        emitCustomEvent: () => undefined,
      };
      return Promise.resolve(execute(value, context));
    };
    const pending = run();
    pending.catch(() => undefined);
    started.set(toolCallId, pending);
  };

  const wrapped = tools.map((tool): AnyServerTool => {
    const execute = tool.execute;
    if (!execute || !readOnlyToolNames.has(tool.name)) return tool;
    return {
      ...tool,
      execute: async (...call: Parameters<typeof execute>) => {
        const [args, context] = call;
        const early = context?.toolCallId ? started.get(context.toolCallId) : undefined;
        if (!early) return execute(args, context);
        started.delete(context?.toolCallId ?? "");
        return early;
      },
    };
  });

  const middleware: ChatMiddleware = {
    name: "memory-agent/parallel-reads",
    onBeforeToolCall(ctx, hook) {
      if (!readOnlyToolNames.has(hook.toolName)) return undefined;
      const answered = new Set(
        ctx.messages.flatMap((message) =>
          message.role === "tool" && message.toolCallId ? [message.toolCallId] : [],
        ),
      );
      const step = [...ctx.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            (message.toolCalls ?? []).some((call) => call.id === hook.toolCallId),
        );
      for (const call of step?.role === "assistant" ? (step.toolCalls ?? []) : []) {
        if (!readOnlyToolNames.has(call.function.name)) break;
        if (answered.has(call.id)) continue;
        const tool = byName.get(call.function.name);
        if (tool) startEarly(call.id, tool, call.function.arguments);
      }
      return undefined;
    },
  };

  return { tools: wrapped, middleware };
}
