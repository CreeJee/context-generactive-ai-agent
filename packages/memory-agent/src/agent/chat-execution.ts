import { chat, type AnyTextAdapter, type InterruptDefinition } from "@tanstack/ai";

// Specify the SDK registry explicitly: its omitted generic defaults to [], which
// rejects every interrupt definition even though this executor forwards them.
type StreamingChat<TAdapter extends AnyTextAdapter> = typeof chat<
  TAdapter,
  undefined,
  true,
  Parameters<typeof chat<TAdapter, undefined, true>>[0]["tools"],
  ReadonlyArray<InterruptDefinition<any, any, any, any>>
>;

/** SDK-derived contract: this boundary runs the complete streaming agent loop. */
export type ChatExecutionOptions<TAdapter extends AnyTextAdapter> = Parameters<
  StreamingChat<TAdapter>
>[0];

type CapabilityKeys =
  | "adapter"
  | "agentLoopStrategy"
  | "tools"
  | "middleware"
  | "abortController"
  | "stream";

/** Owner-prepared input; never rebuild prompts, resume answers or run ids in the executor. */
export type ChatExecutionTurn<TAdapter extends AnyTextAdapter> = Omit<
  ChatExecutionOptions<TAdapter>,
  CapabilityKeys | "outputSchema"
>;

/**
 * Live, owner-issued capabilities, not serializable RPC payloads. Tool implementations and
 * middleware keep approval, persistence, recording and workflow authority at the owner.
 * A future transport must proxy these capabilities rather than giving a worker a database.
 */
export interface ChatExecutionCapabilities<TAdapter extends AnyTextAdapter> {
  readonly model: Pick<ChatExecutionOptions<TAdapter>, "adapter" | "agentLoopStrategy">;
  readonly tools: NonNullable<ChatExecutionOptions<TAdapter>["tools"]>;
  readonly middleware: NonNullable<ChatExecutionOptions<TAdapter>["middleware"]>;
  readonly stream: {
    readonly abortController: AbortController;
  };
}

/** Injection seam for deterministic contract tests; the production implementation is SDK chat. */
export type ChatLoop<TAdapter extends AnyTextAdapter> = (
  options: ChatExecutionOptions<TAdapter>,
) => ReturnType<typeof chat<TAdapter, undefined, true>>;

/**
 * Executes all SDK tool/model iterations, interruptions and middleware, not just adapter.chat().
 * Returns the raw stream: durable receipt logging, live-run tracking, account release and SSE
 * publication remain owner responsibilities. No database, process isolation or retry is added.
 */
export function createChatExecution<TAdapter extends AnyTextAdapter>(
  loop: ChatLoop<TAdapter> = (options) => chat(options),
) {
  return {
    execute(turn: ChatExecutionTurn<TAdapter>, capabilities: ChatExecutionCapabilities<TAdapter>) {
      // Capabilities override turn fields even for callers bypassing TypeScript checks.
      return loop({
        ...turn,
        adapter: capabilities.model.adapter,
        agentLoopStrategy: capabilities.model.agentLoopStrategy,
        tools: capabilities.tools,
        middleware: capabilities.middleware,
        abortController: capabilities.stream.abortController,
        outputSchema: undefined,
        stream: true,
      });
    },
  };
}
