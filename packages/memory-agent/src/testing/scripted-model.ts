import { Array as Arr, Cause, Effect, Option, Predicate, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/ai";
import type { StoredMessage } from "../chat-store/schema.ts";
import { fromPrompt, optionsKey } from "../model/prompt.ts";
import { collectResponse } from "../model/response.ts";

/**
 * Provider-free Effect AI model for tests, as `ScriptedTextAdapter` is for TanStack: the agent
 * loop, tools and persistence still run; only the model's turns are scripted.
 */

export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  /** Sent exactly as a provider would stream tool arguments; text that does not parse stays text. */
  readonly arguments: string;
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<ScriptedToolCall>;
  /** Wait before emitting this turn. Useful for cancellation and concurrency tests. */
  readonly delayMs?: number;
  /** Wait for a test-controlled release; interrupting the step ends the wait. */
  readonly waitFor?: Effect.Effect<void, Cause.UnknownError>;
  /** Stream `text`, then fail the model call with this description. */
  readonly failAfterText?: string;
  /** Provider usage for usage and context-meter tests. */
  readonly usage?: typeof Response.Usage.Encoded;
}

/** One step the model was asked for, with its prompt as stored messages. */
export interface ScriptedInvocation {
  readonly index: number;
  readonly system: ReadonlyArray<string>;
  readonly history: ReadonlyArray<StoredMessage>;
  readonly toolNames: ReadonlyArray<string>;
}

export type ScriptedResponder = (
  invocation: ScriptedInvocation,
) => ScriptedTurn | Effect.Effect<ScriptedTurn, Cause.UnknownError>;

type Part = Response.StreamPartEncoded;

const model = "scripted-1";
const textId = "text-0";

const failed = (description: string) =>
  AiError.make({
    module: "ScriptedLanguageModel",
    method: "streamText",
    reason: AiError.UnknownError.make({ description }),
  });

const decodeArguments = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
/** The parameters of scripted arguments; arguments that do not parse stay text for the caller. */
const paramsOf = (serialized: string) =>
  Option.getOrElse(decodeArguments(serialized === "" ? "{}" : serialized), () => serialized);

const callParts = (call: ScriptedToolCall): Array<Part> => [
  { type: "tool-params-start", id: call.id, name: call.name },
  { type: "tool-params-delta", id: call.id, delta: call.arguments },
  { type: "tool-params-end", id: call.id },
  {
    type: "tool-call",
    id: call.id,
    name: call.name,
    params: paramsOf(call.arguments),
    metadata: { [optionsKey]: { arguments: call.arguments } },
  },
];

/** The parts a turn streams: its text, then its calls and finish, or the failure after its text. */
const turnStream = (turn: ScriptedTurn): Stream.Stream<Part, AiError.AiError> => {
  const opened = Stream.fromIterable<Part>([
    { type: "response-metadata", modelId: model },
    ...(turn.text === undefined
      ? []
      : [
          { type: "text-start", id: textId } as const,
          { type: "text-delta", id: textId, delta: turn.text } as const,
          { type: "text-end", id: textId } as const,
        ]),
  ]);
  if (turn.failAfterText !== undefined)
    return Stream.concat(opened, Stream.fail(failed(turn.failAfterText)));
  const calls = turn.toolCalls ?? [];
  return Stream.concat(
    opened,
    Stream.fromIterable<Part>([
      ...calls.flatMap(callParts),
      {
        type: "finish",
        reason: calls.length > 0 ? "tool-calls" : "stop",
        usage: turn.usage ?? { inputTokens: {}, outputTokens: {} },
      },
    ]),
  );
};

/**
 * A model that answers each step with the next scripted turn, or with what `turns` responds, and
 * records every step it was asked for in `invocations`.
 */
export const makeScriptedModel = Effect.fnUntraced(function* (
  turns: Arr.NonEmptyReadonlyArray<ScriptedTurn> | ScriptedResponder,
) {
  const invocations = yield* Ref.make<ReadonlyArray<ScriptedInvocation>>([]);
  const respond: ScriptedResponder = Predicate.isFunction(turns)
    ? turns
    : (invocation) =>
        Effect.fromOption(Arr.get(turns, invocation.index)).pipe(
          Effect.mapError(
            () =>
              new Cause.UnknownError(
                undefined,
                `scripted model ran out of turns at index ${invocation.index}`,
              ),
          ),
        );
  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const invocation = yield* Ref.modify(
          invocations,
          (recorded): [ScriptedInvocation, ReadonlyArray<ScriptedInvocation>] => {
            const made = {
              index: recorded.length,
              ...fromPrompt(request.prompt),
              toolNames: request.tools.map((tool) => tool.name),
            };
            return [made, [...recorded, made]];
          },
        );
        const response = respond(invocation);
        const turn = yield* Effect.isEffect(response) ? response : Effect.succeed(response);
        yield* turn.waitFor ?? Effect.void;
        yield* turn.delayMs === undefined ? Effect.void : Effect.sleep(turn.delayMs);
        return turnStream(turn);
      }).pipe(
        Effect.catchTag("UnknownError", (error) =>
          Effect.fail(failed(Predicate.isError(error.cause) ? error.cause.message : error.message)),
        ),
      ),
    );
  const languageModel = yield* LanguageModel.make({
    streamText,
    generateText: (request) => collectResponse(streamText(request)),
  });
  return { model: languageModel, invocations: Ref.get(invocations) };
});
