import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { JsonValue } from "../json.ts";

/** Effect RPC between the code sandbox (`sandbox.ts`) and its worker (`worker.ts`). */

/**
 * A program as the worker runs it. What its calls pass and return crosses as JSON text, which the
 * program parses itself.
 */
export const Program = Schema.Struct({
  /** TypeScript or JavaScript: the body of an async function, so it may `await` and `return`. */
  code: Schema.String,
  /** The value the program reads as `input`. */
  input: JsonValue,
  /** The functions the program may call, each as `external_<name>`. */
  functions: Schema.Array(Schema.String),
  /** How long the program may run, waiting on its calls included. */
  timeoutMs: Schema.Finite,
});
export type Program = typeof Program.Type;

/** What a call came back with: the JSON text of its result (absent for none), or why it failed. */
export const CallReply = Schema.TaggedUnion({
  Returned: { value: Schema.optionalKey(Schema.String) },
  Failed: { message: Schema.String },
});
export type CallReply = typeof CallReply.Type;

/** The console lines a program wrote, up to a limit; `dropped` counts the lines past it. */
const logFields = { logs: Schema.Array(Schema.String), dropped: Schema.Finite };

/** How a program ended. */
export const Outcome = Schema.TaggedUnion({
  /** `value` is the JSON text of what it returned; absent when it returned nothing. */
  Returned: { value: Schema.optionalKey(Schema.String), ...logFields },
  /** It threw, or its code does not parse. `line` is the line of the program's code, when known. */
  Threw: {
    name: Schema.String,
    message: Schema.String,
    line: Schema.optionalKey(Schema.Finite),
    ...logFields,
  },
  /** It was still running, or still waiting on a call, when its time ran out. */
  TimedOut: logFields,
});
export type Outcome = typeof Outcome.Type;

/** What a run streams: a `Call` for each function call the program makes, then one `Finished`. */
export const RunEvent = Schema.TaggedUnion({
  Call: { id: Schema.Finite, name: Schema.String, args: Schema.String },
  Finished: { outcome: Outcome },
});
export type RunEvent = typeof RunEvent.Type;

/** The worker could not load its engine; the cause stays in its log. */
export class CodeEngineFailed extends Schema.TaggedError<CodeEngineFailed>()(
  "CodeEngineFailed",
  {},
) {}

/** Runs one program. A worker runs one program and is then stopped. */
export const Run = Rpc.make("Run", {
  payload: Program,
  success: RunEvent,
  error: CodeEngineFailed,
  stream: true,
});
/** Answers the program's call `id`. */
export const Reply = Rpc.make("Reply", {
  payload: Schema.Struct({ id: Schema.Finite, reply: CallReply }),
});

export const CodeRpcs = RpcGroup.make(Run, Reply);
