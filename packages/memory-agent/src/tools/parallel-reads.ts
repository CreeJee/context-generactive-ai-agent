import { MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
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
  "read_tool_result",
  "read_subagent_tool_result",
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
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function parallelReads(tools: readonly AnyServerTool[], signal: AbortSignal): ParallelReads {
  const started = MutableHashMap.empty<string, Promise<unknown>>();
  const byName = MutableHashMap.fromIterable(tools.map((tool) => [tool.name, tool]));
  // SDK results stay until their ordered tool call consumes them, including already settled calls.
  // The SDK owns execution and its AbortSignal; this is a result handoff, not a fiber registry.
  const clear = () => {
    MutableHashMap.clear(started);
    signal.removeEventListener("abort", clear);
  };
  signal.addEventListener("abort", clear, { once: true });

  const startEarly = (toolCallId: string, tool: AnyServerTool, argumentsJson: string) => {
    const execute = tool.execute;
    if (!isTruthy(execute) || signal.aborted || MutableHashMap.has(started, toolCallId)) return;
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
    MutableHashMap.set(started, toolCallId, pending);
  };

  const wrapped = tools.map((tool): AnyServerTool => {
    const execute = tool.execute;
    if (!isTruthy(execute) || !readOnlyToolNames.has(tool.name)) return tool;
    return {
      ...tool,
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      // @effect-diagnostics-next-line asyncFunction:off
      execute: async (...call: Parameters<typeof execute>) => {
        const [args, context] = call;
        const early = isTruthy(context?.toolCallId)
          ? Option.getOrUndefined(MutableHashMap.get(started, context.toolCallId))
          : undefined;
        if (!isTruthy(early)) return execute(args, context);
        MutableHashMap.remove(started, context?.toolCallId ?? "");
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
          message.role === "tool" && isTruthy(message.toolCallId) ? [message.toolCallId] : [],
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
        const tool = Option.getOrUndefined(MutableHashMap.get(byName, call.function.name));
        if (isTruthy(tool)) startEarly(call.id, tool, call.function.arguments);
      }
      return undefined;
    },
  };

  return { tools: wrapped, middleware };
}
