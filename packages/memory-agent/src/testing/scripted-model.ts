import {
  Array as Arr,
  Cause,
  Effect,
  HashMap,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
  String as Str,
  Struct,
} from "effect";
import { AiError, LanguageModel, type Response } from "effect/ai";
import type { StoredMessage } from "../chat-store/schema.ts";
import { fromPrompt, optionsKey } from "../model/prompt.ts";
import { collectResponse } from "../model/response.ts";
import { shownReason } from "../model/shown-failure.ts";
import type { ModelRun, ShownFailure } from "../providers/contracts.ts";
import { discoveryToolName } from "../tools/discovery.ts";
import { isTruthy } from "../truthy.ts";

/**
 * Provider-free Effect AI model for tests: the agent loop, tools and persistence still run; only
 * the model's turns are scripted.
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

/** The run a scripted model answers. */
export type ScriptedRun = Pick<ModelRun, "threadId" | "runId">;

/** One step the model was asked for, with its prompt as stored messages. */
export interface ScriptedInvocation {
  readonly index: number;
  readonly run: ScriptedRun;
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

/** The run a model answers when the test names none. */
const defaultRun: ScriptedRun = { threadId: "scripted-thread", runId: "scripted-run" };

/** What a scripted model's messages are written as. */
export const scriptedSource = { provider: "scripted", api: "text", model };

/** Ids of the discovery calls the model makes for a responder. */
const ownDiscovery = "scripted-discovery-";

const failed = (description: string) =>
  AiError.make({
    module: "ScriptedLanguageModel",
    method: "streamText",
    reason: AiError.UnknownError.make({ description }),
  });

/** A scripted failure as the user sees it: the text the turn was scripted to fail with. */
export const shownScriptedFailure = (error: AiError.AiError): ShownFailure =>
  error.reason._tag === "UnknownError" && error.reason.description !== undefined
    ? { message: error.reason.description }
    : shownReason(error);

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
  const calls = turn.toolCalls ?? [];
  return Stream.concat(
    opened,
    Option.match(Option.fromNullishOr(turn.failAfterText), {
      onNone: () =>
        Stream.fromIterable<Part>([
          ...calls.flatMap(callParts),
          {
            type: "finish",
            reason: calls.length > 0 ? "tool-calls" : "stop",
            usage: turn.usage ?? { inputTokens: {}, outputTokens: {} },
          },
        ]),
      onSome: (failure) => Stream.fail(failed(failure)),
    }),
  );
};

/** The tools a request lists by name only, in the discovery tool's description. */
const lazyToolNames = (request: LanguageModel.ProviderOptions): ReadonlyArray<string> =>
  Arr.findFirst(request.tools, (tool) => tool.name === discoveryToolName).pipe(
    Option.flatMapNullishOr(
      (discovery) => /Available tools: \[([^\]]*)\]/.exec(discovery.description ?? "")?.[1],
    ),
    Option.filter((listed) => listed !== ""),
    Option.match({ onNone: () => [], onSome: Str.split(", ") }),
  );

/** The conversation as the responder wrote it, without the discovery calls made for it. */
const withoutOwnDiscovery = (history: ReadonlyArray<StoredMessage>) =>
  history.flatMap(
    Match.type<StoredMessage>().pipe(
      Match.discriminatorsExhaustive("role")({
        user: (user): ReadonlyArray<StoredMessage> => [user],
        assistant: (assistant) => {
          const calls = assistant.toolCalls ?? [];
          const kept = calls.filter((call) => !call.id.startsWith(ownDiscovery));
          const rest = Struct.omit(assistant, ["toolCalls"]);
          return Arr.isReadonlyArrayNonEmpty(kept)
            ? [{ ...rest, toolCalls: kept }]
            : Arr.filter([rest], () => calls.length === 0 || isTruthy(assistant.content));
        },
        tool: (tool) => Arr.filter([tool], () => !tool.toolCallId.startsWith(ownDiscovery)),
      }),
    ),
  );

/**
 * A model that answers each step with the next scripted turn, or with what `turns` responds, and
 * records every step it was asked for in `invocations`. `forRun` makes the model a run asks; the
 * runs share the turns, the record and the calls waiting for their discovery.
 */
export const scriptedModel = Effect.fnUntraced(function* (
  turns: Arr.NonEmptyReadonlyArray<ScriptedTurn> | ScriptedResponder,
) {
  const invocations = yield* Ref.make<ReadonlyArray<ScriptedInvocation>>([]);
  /** Turns that call lazy tools, by the discovery call made for them. */
  const afterDiscovery = yield* Ref.make(HashMap.empty<string, ScriptedTurn>());
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
  /**
   * Like a model, the turn first asks for the lazy tools among its calls, then makes the calls
   * once their schemas are sent.
   */
  const discoveryFor = (
    turn: ScriptedTurn,
    request: LanguageModel.ProviderOptions,
    id: string,
  ): Effect.Effect<ScriptedTurn> => {
    const lazy = lazyToolNames(request);
    const toolNames = (turn.toolCalls ?? [])
      .map((call) => call.name)
      .filter((name) => lazy.includes(name) && !request.tools.some((tool) => tool.name === name));
    return Arr.isReadonlyArrayNonEmpty(toolNames)
      ? Effect.as(Ref.update(afterDiscovery, HashMap.set(id, turn)), {
          toolCalls: [{ id, name: discoveryToolName, arguments: JSON.stringify({ toolNames }) }],
        })
      : Effect.succeed(turn);
  };
  const streamText = (run: ScriptedRun) => (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const prompt = fromPrompt(request.prompt);
        const answered = Option.flatMap(Arr.last(prompt.history), (message) =>
          message.role === "tool" ? Option.some(message.toolCallId) : Option.none(),
        );
        const waiting = yield* Option.match(answered, {
          onNone: () => Effect.succeedNone,
          onSome: (id) =>
            Ref.modify(
              afterDiscovery,
              (held): [Option.Option<ScriptedTurn>, HashMap.HashMap<string, ScriptedTurn>] => [
                HashMap.get(held, id),
                HashMap.remove(held, id),
              ],
            ),
        });
        return yield* Option.match(waiting, {
          // The turn waited once already, when the responder gave it.
          onSome: (turn) => Effect.succeed(turnStream(turn)),
          onNone: () =>
            Effect.gen(function* () {
              const invocation = yield* Ref.modify(
                invocations,
                (recorded): [ScriptedInvocation, ReadonlyArray<ScriptedInvocation>] => {
                  const made = {
                    index: recorded.length,
                    run,
                    system: prompt.system,
                    history: withoutOwnDiscovery(prompt.history),
                    toolNames: request.tools.map((tool) => tool.name),
                  };
                  return [made, [...recorded, made]];
                },
              );
              const response = respond(invocation);
              const scripted = yield* Effect.isEffect(response)
                ? response
                : Effect.succeed(response);
              const turn = yield* discoveryFor(
                scripted,
                request,
                // Unique across runs, as the run's stored conversation keeps it.
                `${ownDiscovery}${run.runId}-${invocation.index}`,
              );
              yield* Effect.when(
                Effect.andThen(
                  turn.waitFor ?? Effect.void,
                  turn.delayMs === undefined ? Effect.void : Effect.sleep(turn.delayMs),
                ),
                Effect.succeed(turn === scripted),
              );
              return turnStream(turn);
            }),
        });
      }).pipe(
        Effect.catchTag("UnknownError", (error) =>
          Effect.fail(failed(Predicate.isError(error.cause) ? error.cause.message : error.message)),
        ),
      ),
    );
  const forRun = (run: ScriptedRun) =>
    LanguageModel.make({
      streamText: streamText(run),
      generateText: (request) => collectResponse(streamText(run)(request)),
    });
  return { model: yield* forRun(defaultRun), forRun, invocations: Ref.get(invocations) };
});
