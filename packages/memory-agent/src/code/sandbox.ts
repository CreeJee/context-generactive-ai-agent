import { NodeWorker } from "@effect/platform-node";
import { Context, Duration, Effect, Layer, Option, Record, Result, Schema, Stream } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { Worker } from "node:worker_threads";
import { JsonValue } from "../json.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../runtime/resources.ts";
import { CallReply, CodeRpcs, Outcome, RunEvent } from "./protocol.ts";

export { Outcome as ProgramOutcome } from "./protocol.ts";

/**
 * TypeScript the model writes, run in QuickJS in a worker thread of its own. The program reaches
 * nothing but `console` and the functions it is given, each as `external_<name>`: no files, network,
 * processes or timers. A worker runs one program and is stopped after it, so nothing a program
 * leaves behind reaches the next one.
 */

/**
 * A function a program may call as `external_<name>`, with the arguments the program passed. The
 * arguments are the program's own, so the function decodes them as it would a model's.
 */
export type ProgramFunction = (args: JsonValue) => Effect.Effect<unknown, ProgramCallFailed>;

/** A call of the program failed; the program sees `message` as the error the call throws. */
export class ProgramCallFailed extends Schema.TaggedError<ProgramCallFailed>()(
  "ProgramCallFailed",
  { message: Schema.String },
) {}

/**
 * The sandbox could not run the program. `start`: its worker did not start. `engine`: QuickJS did
 * not load. `lost`: the worker stopped while the program ran.
 */
export class CodeSandboxFailed extends Schema.TaggedError<CodeSandboxFailed>()(
  "CodeSandboxFailed",
  { reason: Schema.Literals(["start", "engine", "lost"]) },
) {}

/** Calls of one program that run at once; the program's other calls wait for a free slot. */
const callConcurrency = 8;
/** The worker reports a timeout itself; past this much longer the program is stopped regardless. */
const reportGrace = Duration.seconds(2);

const decodeArguments = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonValue));
/** The JSON text of a call's result; none for a result JSON cannot hold. */
const jsonText = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const returnedReply = Option.match({
  onNone: () => CallReply.cases.Returned.make({}),
  onSome: (text: string) => CallReply.cases.Returned.make({ value: text }),
});

const run = Effect.fn("CodeSandbox.run")(function* (
  program: { readonly code: string; readonly input: JsonValue },
  functions: Readonly<Record<string, ProgramFunction>>,
  timeout: Duration.Duration,
) {
  const workers = NodeWorker.layer(
    () => new Worker(runtimeWorker("code-worker"), runtimeWorkerOptions({})),
  );
  const protocol = yield* Layer.build(
    // `Run` streams for the whole program; the replies to its calls each take a slot beside it.
    RpcClient.layerProtocolWorker({ size: 1, concurrency: callConcurrency + 1 }).pipe(
      Layer.provide(workers),
    ),
  ).pipe(Effect.mapError(() => CodeSandboxFailed.make({ reason: "start" })));
  const client = yield* RpcClient.make(CodeRpcs).pipe(Effect.provideContext(protocol));

  const replyTo = (name: string, args: string): Effect.Effect<CallReply> =>
    Option.match(Record.get(functions, name), {
      onNone: () =>
        Effect.succeed(
          CallReply.cases.Failed.make({ message: `external_${name} is not available here.` }),
        ),
      onSome: (call) =>
        decodeArguments(args).pipe(
          Effect.mapError(() =>
            ProgramCallFailed.make({
              message: `external_${name} got arguments that are not JSON.`,
            }),
          ),
          Effect.flatMap(call),
          Effect.map(jsonText),
          Effect.map(returnedReply),
          Effect.catchTag("ProgramCallFailed", ({ message }) =>
            Effect.succeed(CallReply.cases.Failed.make({ message })),
          ),
        ),
    });

  /** A `Call` is answered and leaves nothing on the stream; `Finished` is the outcome. */
  const handle = (event: RunEvent) =>
    RunEvent.match<Effect.Effect<Result.Result<Outcome, void>, RpcClientError.RpcClientError>>(
      event,
      {
        Call: ({ id, name, args }) =>
          replyTo(name, args).pipe(
            Effect.flatMap((reply) => client.Reply({ id, reply })),
            Effect.as(Result.failVoid),
          ),
        Finished: ({ outcome }) => Effect.succeed(Result.succeed(outcome)),
      },
    );

  return yield* client
    .Run({
      code: program.code,
      input: program.input,
      functions: Record.keys(functions),
      timeoutMs: Duration.toMillis(timeout),
    })
    .pipe(
      Stream.mapEffect(handle, { concurrency: callConcurrency, unordered: true }),
      Stream.filterMap((event) => event),
      Stream.runHead,
      // The first `Finished` ends the stream; calls the program left waiting are stopped with it.
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(CodeSandboxFailed.make({ reason: "lost" })),
          onSome: Effect.succeed,
        }),
      ),
      Effect.timeoutOption(Duration.sum(timeout, reportGrace)),
      Effect.map(Option.getOrElse(() => Outcome.cases.TimedOut.make({ logs: [], dropped: 0 }))),
      Effect.catchTags({
        CodeEngineFailed: () => Effect.fail(CodeSandboxFailed.make({ reason: "engine" })),
        RpcClientError: () => Effect.fail(CodeSandboxFailed.make({ reason: "lost" })),
      }),
    );
}, Effect.scoped);

export class CodeSandbox extends Context.Service<CodeSandbox, { readonly run: typeof run }>()(
  "memory-agent/code/sandbox/CodeSandbox",
) {
  static readonly layer = Layer.succeed(CodeSandbox, { run });
}
