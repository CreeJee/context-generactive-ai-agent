import { isTruthy } from "../truthy.ts";
import { EventType } from "@tanstack/ai";
import { Cause, DateTime, Effect, Option, Schema, Stream } from "effect";
import type {
  AdapterYieldChunk,
  DefaultMessageMetadataByModality,
  ModelMessage,
  TextOptions,
  TokenUsage,
} from "@tanstack/ai";
import { BaseTextAdapter } from "@tanstack/ai/adapters";
import { optionalProperty } from "../optional-property.ts";
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
  /** Wait for a test-controlled release, or stop when the run is aborted. */
  readonly waitFor?: Promise<void> | Effect.Effect<void, Cause.UnknownError>;
  /** Stream `text`, then fail the model call. */
  readonly failAfterText?: string;
  /** Optional provider usage for middleware and context-meter tests. */
  readonly usage?: TokenUsage;
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
) => ScriptedTurn | Promise<ScriptedTurn> | Effect.Effect<ScriptedTurn, Cause.UnknownError>;

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
            if (!isTruthy(turn))
              throw new Error(`scripted adapter ran out of turns at index ${invocation.index}`);
            return turn;
          };
  }

  chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const invocations = this.invocations;
    const respond = this.#respond;
    const stream = Stream.unwrap(
      Effect.gen(function* () {
        const index = invocations.length;
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
        invocations.push(invocation);
        const signal = options.abortController?.signal ?? options.request?.signal ?? undefined;
        const waiting = Effect.gen(function* () {
          const { response } = yield* Effect.try({
            try: () => ({ response: respond(invocation) }),
            catch: (cause) => new Cause.UnknownError(cause),
          });
          const turn = yield* Effect.isEffect(response)
            ? response
            : Effect.tryPromise({
                try: () => Promise.resolve(response),
                catch: (cause) => new Cause.UnknownError(cause),
              });
          const waitFor = turn.waitFor;
          if (waitFor !== undefined)
            yield* Effect.isEffect(waitFor)
              ? waitFor
              : Effect.tryPromise({
                  try: () => waitFor,
                  catch: (cause) => new Cause.UnknownError(cause),
                });
          if (turn.delayMs !== undefined) yield* Effect.sleep(turn.delayMs);
          return turn;
        });

        const aborted =
          signal === undefined
            ? Effect.never
            : Effect.callback<Option.Option<ScriptedTurn>>((resume) => {
                const onAbort = () => {
                  signal.removeEventListener("abort", onAbort);
                  resume(Effect.succeedNone);
                };
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
                return Effect.sync(() => signal.removeEventListener("abort", onAbort));
              });
        const result = yield* Effect.raceFirst(Effect.asSome(waiting), aborted);
        if (Option.isNone(result) || signal?.aborted === true) return Stream.empty;
        const turn = result.value;
        return Stream.fromIterable(
          (function* (): Generator<AdapterYieldChunk> {
            const runId = options.runId ?? `scripted-run-${index}`;
            const threadId = options.threadId ?? "scripted-thread";
            const messageId = `${runId}-message-${index}`;
            const timestamp = DateTime.toEpochMillis(DateTime.nowUnsafe());

            yield { type: EventType.RUN_STARTED, runId, threadId, model, timestamp };
            if (turn.text !== undefined) {
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
                model,
                timestamp,
              };
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: turn.text,
                model,
                timestamp,
              };
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
              ...optionalProperty("usage", turn.usage),
            };
          })(),
          { chunkSize: 1 },
        );
      }),
    );
    // The SDK consumes the original native rejection; the internal wait has a typed error channel.
    return Stream.toAsyncIterable(Stream.mapError(stream, (error) => error.cause));
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(new Error("scripted adapter does not implement structured output"));
  }
}
