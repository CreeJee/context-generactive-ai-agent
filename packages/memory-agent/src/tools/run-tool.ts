import { Cause, Effect, type JsonSchema, Option, Predicate, Schema } from "effect";
import { Tool } from "effect/ai";
import { JsonValue } from "../json.ts";
import { ToolFailed, ToolFailureResult, toolFailedOf } from "./failure.ts";

/**
 * A run's tools for the Effect AI loop (docs/effect-ai-migration.md step 3): the Effect AI tool the
 * model is told about, and how a call of it runs. The loop decodes a call's arguments before
 * anything else, so a call that does not match its schema never reaches a gate, and runs the call
 * once the gates and the scheduler let it.
 */

/** One call of a tool, as its handler sees it. */
export interface ToolCall {
  readonly toolCallId: string;
}

/** A call whose arguments matched its tool's schema. Its failure is what the model reads. */
export type PreparedCall = (call: ToolCall) => Effect.Effect<JsonValue, ToolFailed>;

export interface RunTool {
  readonly tool: Tool.Any;
  /** Listed by name only until the model asks for it (TanStack's lazy tools). */
  readonly lazy: boolean;
  /** The call with these arguments, when they match the tool's schema. */
  readonly prepare: (params: JsonValue) => Effect.Effect<PreparedCall, Schema.SchemaError>;
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonValue));
const encodeJsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const notJson = ToolFailed.make({
  code: "tool_failed",
  tag: "InvalidToolResult",
  detail: "The result is not JSON.",
});

/**
 * A result as the model reads it, which is what TanStack kept: a text that is JSON parsed, and the
 * JSON of anything else, so a field left undefined is gone as it is from the stored message.
 */
const toolOutput = <A>(result: A): Effect.Effect<JsonValue, ToolFailed> =>
  Predicate.isString(result)
    ? Effect.succeed(Option.getOrElse(decodeJsonText(result), () => result))
    : encodeJsonText(result ?? null).pipe(
        Effect.flatMap((text) => Effect.fromOption(decodeJsonText(text))),
        Effect.mapError(() => notJson),
      );

/** Any failure of a call as the model reads it; a cancelled call stays cancelled. */
const failedCall = <E>(cause: Cause.Cause<E>): Effect.Effect<never, ToolFailed> => {
  const failure = Cause.squash(cause);
  // `guardedEffect` hands its model-facing failure over inside an UnknownError.
  const error =
    failure instanceof Cause.UnknownError && Predicate.isError(failure.cause)
      ? failure.cause
      : failure;
  return Cause.hasInterrupts(cause)
    ? Effect.interrupt
    : // A thrown non-Error carries nothing the model may see.
      Effect.fail(toolFailedOf(Predicate.isError(error) ? error : new Error("unknown")));
};

/** Makes a tool from its definition and its handler, which may fail in any way. */
export const runTool = <
  const Name extends string,
  Parameters extends Schema.Decoder<unknown>,
  A,
  E,
>({
  handler,
  ...options
}: {
  readonly name: Name;
  readonly description: string;
  readonly parameters: Parameters;
  /** Sent as written in place of the parameters' own JSON Schema; they still decode the call. */
  readonly jsonSchema?: JsonSchema.JsonSchema;
  /** `true`: the call never runs without the user's approval (`definitions.ts`). */
  readonly needsApproval?: boolean;
  readonly lazy?: boolean;
  readonly handler: (params: Parameters["Type"], call: ToolCall) => Effect.Effect<A, E>;
}): RunTool => {
  const decode = Schema.decodeUnknownEffect(options.parameters);
  const definition = {
    description: options.description,
    success: JsonValue,
    failure: ToolFailureResult,
    failureMode: "return",
    needsApproval: options.needsApproval,
  } as const;
  return {
    tool:
      options.jsonSchema === undefined
        ? Tool.make(options.name, { ...definition, parameters: options.parameters })
        : Tool.dynamic(options.name, { ...definition, parameters: options.jsonSchema }),
    lazy: options.lazy ?? false,
    prepare: (params) =>
      Effect.map(
        decode(params),
        (decoded): PreparedCall =>
          (call) =>
            handler(decoded, call).pipe(Effect.flatMap(toolOutput), Effect.catchCause(failedCall)),
      ),
  };
};
