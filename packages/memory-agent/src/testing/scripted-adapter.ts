import { EventType } from "@tanstack/ai";
import { Schema } from "effect";
import type {
  AdapterYieldChunk,
  DefaultMessageMetadataByModality,
  ModelMessage,
  TextOptions,
} from "@tanstack/ai";
import { BaseTextAdapter } from "@tanstack/ai/adapters";
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters";

/**
 * Provider-free adapter for tests. The real chat engine still runs the agent loop, tools,
 * middleware and AG-UI events; only the model's turns are scripted.
 */
export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  /** Sent to the engine exactly as a provider would stream tool arguments. */
  readonly arguments: string;
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
  /** Wait before emitting this turn. Useful for cancellation and concurrency tests. */
  readonly delayMs?: number;
  /** Stream `text`, then fail the model call. */
  readonly failAfterText?: string;
}

export interface AdapterInvocation {
  readonly index: number;
  readonly runId: string | undefined;
  readonly threadId: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly systemPrompts: readonly string[];
  readonly toolNames: readonly string[];
}

export type ScriptedResponder = (
  invocation: AdapterInvocation,
) => ScriptedTurn | Promise<ScriptedTurn>;

const model = "scripted-1";

export class ScriptedTextAdapter extends BaseTextAdapter<
  typeof model,
  Record<string, never>,
  ["text", "image"],
  DefaultMessageMetadataByModality
> {
  readonly name = "scripted";
  readonly invocations: AdapterInvocation[] = [];
  readonly #respond: ScriptedResponder;

  constructor(turns: readonly ScriptedTurn[] | ScriptedResponder) {
    super({}, model);
    if (Array.isArray(turns) && turns.length === 0)
      throw new Error("scripted adapter needs at least one turn");
    this.#respond =
      turns instanceof Function
        ? turns
        : (invocation) => {
            const turn = turns[invocation.index];
            if (!turn)
              throw new Error(`scripted adapter ran out of turns at index ${invocation.index}`);
            return turn;
          };
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const index = this.invocations.length;
    const invocation: AdapterInvocation = {
      index,
      runId: options.runId,
      threadId: options.threadId,
      messages: structuredClone(options.messages),
      systemPrompts: (options.systemPrompts ?? []).map((prompt) =>
        Schema.is(Schema.String)(prompt) ? prompt : prompt.content,
      ),
      toolNames: (options.tools ?? []).map((tool) => tool.name),
    };
    this.invocations.push(invocation);
    const turn = await this.#respond(invocation);
    if (turn.delayMs !== undefined)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, turn.delayMs);
        options.abortController?.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(options.abortController?.signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });

    const runId = options.runId ?? `scripted-run-${index}`;
    const threadId = options.threadId ?? "scripted-thread";
    const messageId = `${runId}-message-${index}`;
    const timestamp = Date.now();

    yield { type: EventType.RUN_STARTED, runId, threadId, model, timestamp };
    if (turn.text !== undefined) {
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp };
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: turn.text, model, timestamp };
      yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp };
    }
    if (turn.failAfterText !== undefined) throw new Error(turn.failAfterText);

    const toolCalls = turn.toolCalls ?? [];
    for (const [position, call] of toolCalls.entries()) {
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: call.id,
        toolCallName: call.name,
        parentMessageId: messageId,
        index: position,
        model,
        timestamp,
      };
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: call.id,
        delta: call.arguments,
        model,
        timestamp,
      };
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: call.id,
        toolCallName: call.name,
        model,
        timestamp,
      };
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(new Error("scripted adapter does not implement structured output"));
  }
}
