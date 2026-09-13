import { randomUUID } from "node:crypto";
import {
  EventType,
  convertSchemaToJsonSchema,
  normalizeSystemPrompts,
  type AdapterYieldChunk,
  type DefaultMessageMetadataByModality,
  type ModelMessage,
  type TextOptions,
} from "@tanstack/ai";
import {
  BaseTextAdapter,
  type StructuredOutputOptions,
  type StructuredOutputResult,
} from "@tanstack/ai/adapters";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { CodexAppServer } from "./app-server.ts";
import { toCodexTurnInput } from "./history.ts";
import type { ModelSelection } from "./models.ts";
import {
  CodexTurn,
  DeltaNotification,
  ErrorNotification,
  TokenUsageNotification,
  ToolCallRequest,
  TurnCompletedNotification,
  type PendingToolCall,
  type TurnEvent,
} from "./turn.ts";

const ThreadStarted = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });
const TurnStarted = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });
const Ignored = Schema.Unknown;

const defaultInstructions = "You are a helpful assistant.";
/** Parallel tool calls from one model step arrive within a few milliseconds of each other. */
const toolCallSettleMs = 25;
/** A turn left waiting on tool results this long is abandoned (e.g. the run paused for approval). */
const idleTurnMs = 15 * 60_000;

/** What the adapter needs from codex, kept small so it is easy to fake in tests. */
export interface CodexTurns {
  start(options: TextOptions<Record<string, never>>, selection: ModelSelection): Promise<CodexTurn>;
  interrupt(turn: CodexTurn): Promise<void>;
}

/**
 * TanStack text adapter backed by the ChatGPT account through codex app-server.
 *
 * Each agent-loop iteration either continues the codex turn that is waiting on tool results
 * (same chat() request), or starts a fresh ephemeral thread with the conversation injected.
 * Codex tool requests become TanStack tool calls, so approval, execution and recording stay in
 * TanStack for both direct and code-mode models.
 */
export class CodexTextAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  ["text"],
  DefaultMessageMetadataByModality
> {
  readonly name = "codex";
  #live: CodexTurn | null = null;
  #idle: NodeJS.Timeout | null = null;
  /**
   * A read that lost a race against the settle timer. It still resolves with the next event, so
   * the following read must reuse it; calling events.next() again would skip that event.
   */
  #nextEvent: Promise<IteratorResult<TurnEvent>> | null = null;

  constructor(
    private readonly turns: CodexTurns,
    private readonly selection: ModelSelection,
  ) {
    super({}, selection.model);
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const signal = options.abortController?.signal;
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const model = this.selection.model;
    const stamp = () => ({ model, timestamp: Date.now() });

    const turn =
      this.#continue(options.messages) ?? (await this.turns.start(options, this.selection));
    const abort = () => void this.turns.interrupt(turn);
    signal?.addEventListener("abort", abort, { once: true });

    const messageId = randomUUID();
    let textOpen = false;
    let usage: (TurnEvent & { kind: "usage" }) | null = null;
    yield { ...stamp(), type: EventType.RUN_STARTED, runId, threadId };

    try {
      for (;;) {
        const step = await this.#read(turn);
        if (signal?.aborted) return;

        if (step.done) {
          if (textOpen) yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
          this.#live = null;
          const finished: AdapterYieldChunk = {
            ...stamp(),
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            finishReason: "stop",
          };
          if (usage) finished.usage = usage.usage;
          yield finished;
          return;
        }

        const event = step.value;
        if (event.kind === "usage") usage = event;
        else if (event.kind === "delta") {
          if (!textOpen) {
            textOpen = true;
            yield { ...stamp(), type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
          }
          yield { ...stamp(), type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.text };
        } else {
          const calls = await this.#settleToolCalls(turn, event.call);
          if (textOpen) yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
          for (const [index, call] of calls.entries()) {
            yield {
              ...stamp(),
              type: EventType.TOOL_CALL_START,
              toolCallId: call.callId,
              toolCallName: call.name,
              parentMessageId: messageId,
              index,
            };
            yield {
              ...stamp(),
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: call.callId,
              delta: call.arguments,
            };
            yield {
              ...stamp(),
              type: EventType.TOOL_CALL_END,
              toolCallId: call.callId,
              toolCallName: call.name,
            };
          }
          this.#park(turn);
          yield {
            ...stamp(),
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            finishReason: "tool_calls",
          };
          return;
        }
      }
    } catch (failure) {
      this.#live = null;
      throw new Error(Schema.is(Schema.String)(failure) ? failure : "Codex turn failed.");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(
      new Error("The codex adapter does not support separate structured output."),
    );
  }

  #read(turn: CodexTurn): Promise<IteratorResult<TurnEvent>> {
    const next = this.#nextEvent ?? turn.events.next();
    this.#nextEvent = null;
    return next;
  }

  /** Collects tool calls codex issued together, so TanStack runs them in one step. */
  async #settleToolCalls(turn: CodexTurn, first: PendingToolCall) {
    const calls = [first];
    for (;;) {
      const next = this.#read(turn);
      const timer = new Promise<"settled">((resolve) =>
        setTimeout(() => resolve("settled"), toolCallSettleMs),
      );
      const winner = await Promise.race([next, timer]);
      if (winner === "settled" || winner.done || winner.value.kind !== "toolCall") {
        // Not a parallel tool call: leave it for the next read, consumed or not.
        this.#nextEvent = next;
        return calls;
      }
      calls.push(winner.value.call);
    }
  }

  /** Keeps a turn waiting for tool results until the next iteration of this chat() request. */
  #park(turn: CodexTurn) {
    this.#live = turn;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (this.#live !== turn) return;
      this.#live = null;
      void this.turns.interrupt(turn);
    }, idleTurnMs);
    this.#idle.unref();
  }

  /** Hands tool results to the parked turn. Returns null when a fresh thread is needed instead. */
  #continue(messages: readonly ModelMessage[]): CodexTurn | null {
    const turn = this.#live;
    this.#live = null;
    if (this.#idle) clearTimeout(this.#idle);
    if (!turn || turn.finished) return null;

    const results = new Map(
      messages.flatMap((message) =>
        message.role === "tool" && message.toolCallId
          ? [[message.toolCallId, message] as const]
          : [],
      ),
    );
    const pending = [...turn.awaiting.values()];
    if (pending.length === 0 || pending.some((call) => !results.has(call.callId))) {
      void this.turns.interrupt(turn);
      this.#nextEvent = null;
      return null;
    }
    for (const call of pending) {
      const message = results.get(call.callId)!;
      const text = Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("")
        : (message.content ?? "");
      call.result.resolve({ text, success: message.error === undefined });
    }
    return turn;
  }
}

const make = Effect.gen(function* () {
  const codex = yield* CodexAppServer;
  const turns = new Map<string, CodexTurn>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const forThread = <A extends { readonly threadId?: string }>(value: A) =>
    value.threadId === undefined ? undefined : turns.get(value.threadId);

  codex.onNotification("item/agentMessage/delta", (params) =>
    Option.map(Schema.decodeUnknownOption(DeltaNotification)(params), (delta) =>
      forThread(delta)?.push({ kind: "delta", text: delta.delta }),
    ),
  );
  codex.onNotification("thread/tokenUsage/updated", (params) =>
    Option.map(Schema.decodeUnknownOption(TokenUsageNotification)(params), (update) =>
      forThread(update)?.push({
        kind: "usage",
        usage: {
          promptTokens: update.tokenUsage.last.inputTokens,
          completionTokens: update.tokenUsage.last.outputTokens,
          totalTokens: update.tokenUsage.last.totalTokens,
        },
      }),
    ),
  );
  codex.onNotification("turn/completed", (params) =>
    Option.map(Schema.decodeUnknownOption(TurnCompletedNotification)(params), (completed) => {
      const turn = forThread(completed);
      if (!turn) return;
      turns.delete(turn.threadId);
      turn.finish(
        completed.turn.status === "completed" ? undefined : `Codex turn ${completed.turn.status}.`,
      );
      void run(
        Effect.ignore(codex.request("thread/unsubscribe", { threadId: turn.threadId }, Ignored)),
      );
    }),
  );
  codex.onNotification("error", (params) =>
    Option.map(Schema.decodeUnknownOption(ErrorNotification)(params), (error) => {
      if (error.willRetry) return;
      const turn = forThread(error);
      if (!turn) return;
      turns.delete(turn.threadId);
      turn.finish("The model request failed.");
    }),
  );
  codex.onRequest("item/tool/call", (params) => {
    const request = Schema.decodeUnknownOption(ToolCallRequest)(params);
    if (Option.isNone(request)) return Promise.reject(new Error("Malformed tool call."));
    const turn = turns.get(request.value.threadId);
    if (!turn) return Promise.reject(new Error("No active turn for this thread."));
    return turn.requestTool(
      request.value.callId,
      request.value.tool,
      JSON.stringify(request.value.arguments ?? {}),
    );
  });

  const bridge: CodexTurns = {
    async start(options, selection) {
      const instructions = normalizeSystemPrompts(options.systemPrompts ?? []).map(
        (prompt) => prompt.content,
      );
      const dynamicTools = (options.tools ?? []).map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        deferLoading: false,
        inputSchema: convertSchemaToJsonSchema(tool.inputSchema) ?? {
          type: "object",
          properties: {},
        },
      }));
      const { history, input } = toCodexTurnInput(options.messages);

      const thread = await run(
        codex.request(
          "thread/start",
          {
            model: selection.model,
            modelProvider: "openai",
            allowProviderModelFallback: false,
            ephemeral: true,
            approvalPolicy: "never",
            sandbox: "read-only",
            runtimeWorkspaceRoots: [],
            baseInstructions:
              instructions.length > 0 ? instructions.join("\n\n") : defaultInstructions,
            developerInstructions: "",
            dynamicTools,
          },
          ThreadStarted,
        ),
      );
      const turn = new CodexTurn(thread.thread.id);
      turns.set(turn.threadId, turn);
      try {
        if (history.length > 0)
          await run(
            codex.request(
              "thread/inject_items",
              { threadId: turn.threadId, items: history },
              Ignored,
            ),
          );
        const started = await run(
          codex.request(
            "turn/start",
            {
              threadId: turn.threadId,
              model: selection.model,
              effort: selection.reasoningEffort,
              input,
            },
            TurnStarted,
          ),
        );
        turn.turnId = started.turn.id;
        return turn;
      } catch (error) {
        turns.delete(turn.threadId);
        turn.finish("Could not start the codex turn.");
        throw error;
      }
    },

    async interrupt(turn) {
      if (turn.finished) return;
      if (turn.turnId)
        await run(
          Effect.ignore(
            codex.request(
              "turn/interrupt",
              { threadId: turn.threadId, turnId: turn.turnId },
              Ignored,
            ),
          ),
        );
      turns.delete(turn.threadId);
      turn.finish("Codex turn interrupted.");
    },
  };

  return {
    /** A TanStack adapter for one chat() request using the saved model selection. */
    adapter: (selection: ModelSelection) => new CodexTextAdapter(bridge, selection),
  };
});

/** Chat through the signed-in ChatGPT account. */
export class CodexChat extends Context.Tag("memory-agent/CodexChat")<
  CodexChat,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(CodexChat, make);
}
