import { randomUUID } from "node:crypto";
import {
  EventType,
  convertSchemaToJsonSchema,
  normalizeSystemPrompts,
  type AdapterYieldChunk,
  type AgentLoopStrategy,
  type ChatMiddleware,
  type ChatMiddlewareContext,
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
import { CodexAppServer, type Json } from "./app-server.ts";
import { Attachments } from "../attachments/attachments.ts";
import { attachmentIdOf } from "../attachments/urls.ts";
import { imageSources, toCodexTurnInput, type ResolvedImage } from "./history.ts";
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
  /** Adds user input to a turn that is still going (codex `turn/steer`). */
  steer(turn: CodexTurn, input: readonly Json[]): Promise<void>;
}

/**
 * The codex turn each conversation thread is running, answering or waiting on tools, so a message
 * sent meanwhile can be steered into it.
 */
export class ActiveTurns {
  readonly #byThread = new Map<string, CodexTurn>();

  set(threadId: string, turn: CodexTurn) {
    this.#byThread.set(threadId, turn);
  }

  get(threadId: string): CodexTurn | null {
    const turn = this.#byThread.get(threadId);
    if (!turn || turn.finished || !turn.turnId) return null;
    return turn;
  }
}

type EventRead = Promise<IteratorResult<TurnEvent>>;

interface ParkedTurn {
  readonly turn: CodexTurn;
  /** A read already in flight when the turn was parked; the next reader must reuse it. */
  readonly nextEvent: EventRead | null;
  readonly idle: NodeJS.Timeout;
}

/**
 * Codex turns waiting on tool results, keyed by conversation thread. A run that pauses for the
 * user's approval ends its HTTP request; the continuation arrives as a new request with a new
 * adapter, and finds the waiting turn here so codex keeps its context instead of starting over.
 */
export class TurnParking {
  readonly #parked = new Map<string, ParkedTurn>();

  private readonly interrupt: (turn: CodexTurn) => void;
  private readonly idleMs: number;

  constructor(interrupt: (turn: CodexTurn) => void, idleMs = idleTurnMs) {
    this.interrupt = interrupt;
    this.idleMs = idleMs;
  }

  park(threadId: string, turn: CodexTurn, nextEvent: EventRead | null) {
    const previous = this.take(threadId);
    if (previous && previous.turn !== turn) this.interrupt(previous.turn);
    const idle = setTimeout(() => {
      if (this.#parked.get(threadId)?.turn !== turn) return;
      this.#parked.delete(threadId);
      this.interrupt(turn);
    }, this.idleMs);
    idle.unref();
    this.#parked.set(threadId, { turn, nextEvent, idle });
  }

  take(threadId: string): ParkedTurn | null {
    const parked = this.#parked.get(threadId);
    if (!parked) return null;
    clearTimeout(parked.idle);
    this.#parked.delete(threadId);
    return parked;
  }

  /** Ends the turn still waiting on tool results for a run that will not continue it. */
  release(threadId: string) {
    const parked = this.take(threadId);
    if (parked) this.interrupt(parked.turn);
  }
}

/**
 * Codex decides when a turn is done, so every model step that ends in tool calls is followed by
 * another: that is where the results go back to the waiting codex turn. TanStack's default of five
 * model steps ended runs right after a fifth sequential tool call, with its result never delivered
 * and no answer written, recorded as completed.
 */
export const codexAgentLoop: AgentLoopStrategy = ({ iterationCount, finishReason }) =>
  iterationCount === 0 || finishReason === "tool_calls";

/**
 * What a run through codex needs besides {@link codexAgentLoop}: whenever it ends (finished, failed
 * or cancelled) the codex turn it left waiting on tool results is ended too, so codex does not keep
 * waiting. A run paused for approval does not end, and keeps its turn. There is no cap on tool
 * calls: a run ends when codex answers, the user cancels, or something fails.
 */
export function codexRunMiddleware(parking: TurnParking): ChatMiddleware {
  const release = (ctx: ChatMiddlewareContext) => parking.release(ctx.threadId);
  return { name: "memory-agent/codex-run", onFinish: release, onError: release, onAbort: release };
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
  ["text", "image"],
  DefaultMessageMetadataByModality
> {
  readonly name = "codex";
  /**
   * A read that lost a race against the settle timer. It still resolves with the next event, so
   * the following read must reuse it; calling events.next() again would skip that event.
   */
  #nextEvent: EventRead | null = null;
  /** Parking key when the caller gave no thread id: still shared by this request's iterations. */
  readonly #fallbackThreadId = randomUUID();

  private readonly turns: CodexTurns;
  private readonly selection: ModelSelection;
  private readonly parking: TurnParking;
  private readonly active: ActiveTurns;

  constructor(
    turns: CodexTurns,
    selection: ModelSelection,
    parking: TurnParking,
    active = new ActiveTurns(),
  ) {
    super({}, selection.model);
    this.turns = turns;
    this.selection = selection;
    this.parking = parking;
    this.active = active;
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    // chat() hands its abort signal over on `request`; `abortController` is for direct callers.
    const signal = options.abortController?.signal ?? options.request?.signal ?? undefined;
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? this.#fallbackThreadId;
    const model = this.selection.model;
    const stamp = () => ({ model, timestamp: Date.now() });

    const turn =
      this.#continue(threadId, options.messages) ??
      (await this.turns.start(options, this.selection));
    this.active.set(threadId, turn);
    const abort = () => void this.turns.interrupt(turn);
    signal?.addEventListener("abort", abort, { once: true });

    const messageId = randomUUID();
    let textOpen = false;
    let textItem: string | null = null;
    let usage: (TurnEvent & { kind: "usage" }) | null = null;
    yield { ...stamp(), type: EventType.RUN_STARTED, runId, threadId };

    try {
      for (;;) {
        const step = await this.#read(turn);
        if (signal?.aborted) return;

        if (step.done) {
          if (textOpen) yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
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
          // A second codex message in the same answer (e.g. after a steered message) starts a new
          // paragraph instead of running on from the last sentence.
          const newItem = textOpen && event.itemId !== null && event.itemId !== textItem;
          if (event.itemId !== null) textItem = event.itemId;
          if (!textOpen) {
            textOpen = true;
            yield { ...stamp(), type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
          }
          const delta = newItem ? `\n\n${event.text}` : event.text;
          yield { ...stamp(), type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta };
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
          this.parking.park(threadId, turn, this.#nextEvent);
          this.#nextEvent = null;
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
      // Interrupting the turn on abort ends it with an error; the run was cancelled, not failed.
      if (signal?.aborted) return;
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

  /** Hands tool results to the parked turn. Returns null when a fresh thread is needed instead. */
  #continue(threadId: string, messages: readonly ModelMessage[]): CodexTurn | null {
    const parked = this.parking.take(threadId);
    if (!parked || parked.turn.finished) return null;
    const { turn } = parked;
    this.#nextEvent = parked.nextEvent;

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
  const attachments = yield* Attachments;

  /** Stored images the messages point to. Sources that are not our attachments are left out. */
  const resolveImages = async (sources: readonly string[]) => {
    const resolved = new Map<string, ResolvedImage>();
    for (const source of new Set(sources)) {
      const id = attachmentIdOf(source);
      const attachment = id ? attachments.get(id) : null;
      if (attachment)
        resolved.set(source, {
          path: attachments.pathOf(attachment),
          dataUrl: await attachments.dataUrl(attachment),
        });
    }
    return resolved;
  };
  const turns = new Map<string, CodexTurn>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const forThread = <A extends { readonly threadId?: string }>(value: A) =>
    value.threadId === undefined ? undefined : turns.get(value.threadId);

  codex.onNotification("item/agentMessage/delta", (params) =>
    Option.map(Schema.decodeUnknownOption(DeltaNotification)(params), (delta) =>
      forThread(delta)?.push({ kind: "delta", text: delta.delta, itemId: delta.itemId }),
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
      const { history, input } = toCodexTurnInput(
        options.messages,
        await resolveImages(imageSources(options.messages)),
      );

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

    async steer(turn, input) {
      if (!turn.turnId) throw new Error("The codex turn has not started.");
      await run(
        codex.request(
          "turn/steer",
          { threadId: turn.threadId, expectedTurnId: turn.turnId, input },
          Ignored,
        ),
      );
    },
  };

  const parking = new TurnParking((turn) => void bridge.interrupt(turn));
  const active = new ActiveTurns();

  return {
    /** A TanStack adapter for one chat() request using the saved model selection. */
    adapter: (selection: ModelSelection) =>
      new CodexTextAdapter(bridge, selection, parking, active),

    /** Pass as `agentLoopStrategy` to every chat() with this adapter and tools. */
    agentLoop: codexAgentLoop,

    /** Add to every chat() with this adapter and tools. */
    runMiddleware: () => codexRunMiddleware(parking),

    /**
     * Sends a user message into the turn the thread is running. `no_turn` when nothing is running
     * there (the message then has to reach the model with the conversation instead). Throws when
     * codex refuses it.
     */
    steer: async (threadId: string, message: ModelMessage): Promise<"steered" | "no_turn"> => {
      const turn = active.get(threadId);
      if (!turn) return "no_turn";
      const { input } = toCodexTurnInput([message], await resolveImages(imageSources([message])));
      await bridge.steer(turn, input);
      return "steered";
    },
  };
});

/** Chat through the signed-in ChatGPT account. */
export class CodexChat extends Context.Tag("memory-agent/CodexChat")<
  CodexChat,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(CodexChat, make);
}
