import { Cause, Data, Effect, type JsonSchema, Option, Predicate, Schema } from "effect";
import { Tool } from "effect/ai";
import { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";
import { ToolFailed, ToolFailureResult, toolFailedOf } from "./failure.ts";

/**
 * A run's tools for the Effect AI loop (docs/effect-ai-migration.md step 3): the Effect AI tool the
 * model is told about, and how a call of it runs. The loop decodes a call's arguments before
 * anything else, so a call that does not match its schema never reaches a gate, and runs the call
 * once the gates and the scheduler let it. It prepares calls through `prepareRepaired`
 * (`input-repair.ts`), so arguments TanStack repaired are still accepted.
 */

/** One call of a tool, as its handler sees it. */
export interface ToolCall {
  readonly toolCallId: string;
}

/** A call whose arguments matched its tool's schema. Its failure is what the model reads. */
export type PreparedCall = (call: ToolCall) => Effect.Effect<JsonValue, ToolFailed>;

/**
 * How one call runs, decided from its arguments before the approval and the gates see it. A path
 * the model wrote in another form than the tool expects must not ask the user anything it would
 * not ask otherwise (`files/path-policy.ts`).
 */
export type CallPlan<P> = Data.TaggedEnum<{
  /** With the arguments as given, through the approval and the gates. */
  AsGiven: {};
  /**
   * With `params`, which do only what a tool without approval does (an outside write that lands in
   * the project is a project file write), so no approval or gate asks about it.
   */
  Ungated: { readonly params: P };
  /** With `params` in place of the given arguments; the approval and the gates see `params`. */
  Rewritten: { readonly params: P };
}>;
interface CallPlanDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: CallPlan<this["A"]>;
}
export const CallPlan = Data.taggedEnum<CallPlanDefinition>();

export interface RunTool {
  readonly tool: Tool.Any;
  /** Listed by name only until the model asks for it (TanStack's lazy tools). */
  readonly lazy: boolean;
  /** The call with these arguments, when they match the tool's schema. */
  readonly prepare: (params: JsonValue) => Effect.Effect<PreparedCall, Schema.SchemaError>;
  /** How a call with these arguments runs; without it, every call runs as given. */
  readonly plan?: (params: JsonValue) => Effect.Effect<CallPlan<JsonValue>>;
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonValue));
const encodeJsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const asJson = Schema.decodeUnknownEffect(JsonValue);

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

/** A call that may fail in any way, with its result and failure as the model reads them. */
export const preparedCall =
  <A, E>(run: (call: ToolCall) => Effect.Effect<A, E>): PreparedCall =>
  (call) =>
    run(call).pipe(Effect.flatMap(toolOutput), Effect.catchCause(failedCall));

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
  /**
   * How a call with these arguments runs. A plan whose arguments are not JSON, like arguments that
   * do not match the schema, leaves the call as given.
   */
  readonly plan?: (params: Parameters["Type"]) => Effect.Effect<CallPlan<Parameters["Type"]>>;
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
      Effect.map(decode(params), (decoded) => preparedCall((call) => handler(decoded, call))),
    ...optionalProperty(
      "plan",
      Option.getOrUndefined(
        Option.map(
          Option.fromNullishOr(options.plan),
          (plan) => (params: JsonValue) =>
            decode(params).pipe(
              Effect.flatMap(plan),
              Effect.flatMap(
                CallPlan.$match({
                  AsGiven: () => Effect.succeed(CallPlan.AsGiven<JsonValue>()),
                  Ungated: ({ params: planned }) =>
                    Effect.map(asJson(planned), (json) => CallPlan.Ungated({ params: json })),
                  Rewritten: ({ params: planned }) =>
                    Effect.map(asJson(planned), (json) => CallPlan.Rewritten({ params: json })),
                }),
              ),
              Effect.orElseSucceed(() => CallPlan.AsGiven<JsonValue>()),
            ),
        ),
      ),
    ),
  };
};
