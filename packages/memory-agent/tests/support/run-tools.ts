import { Effect, Function as EffectFunction, Schema } from "effect";
import type { JsonValue } from "../../src/json.ts";
import { ToolFailed } from "../../src/tools/failure.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";

/**
 * A call of the tool named `name` with `params`, run as the loop runs it once its gates let it: its
 * result, or the failure the model reads. A tool that is not there is a `NoSuchElementError`.
 */
export const callTool: {
  (
    name: string,
    params: JsonValue,
  ): (tools: ReadonlyArray<RunTool>) => ReturnType<typeof callToolBody>;
} & typeof callToolBody = EffectFunction.dual(3, callToolBody);
function callToolBody(tools: ReadonlyArray<RunTool>, name: string, params: JsonValue) {
  return Effect.fromNullishOr(tools.find(({ tool }) => tool.name === name)).pipe(
    Effect.flatMap((found) => found.prepare(params)),
    Effect.flatMap((run) => run({ toolCallId: `call-${name}` })),
  );
}

/** The code of the failure the model reads, or `resolved`. */
export const failureCode = <A, E>(call: Effect.Effect<A, E | ToolFailed>) =>
  call.pipe(
    Effect.map(() => "resolved"),
    Effect.catchIf(Schema.is(ToolFailed), (error) => Effect.succeed(error.code)),
  );
