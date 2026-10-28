// Runs one program for the code sandbox (`sandbox.ts`) in a worker thread. QuickJS runs a program on
// the thread that calls it until the program awaits or ends: on the server's thread a busy program
// held up every request until its time ran out, and a deep recursion overflowed that thread's stack.
// In a checkout Node runs this file as TypeScript; the executable ships it bundled
// (`scripts/package.ts`).
// The module itself, not the package index: the index loads every Node service and slows each start.
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type DisposableResult,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import { transform } from "sucrase";
import {
  type Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  HashMap,
  Layer,
  MutableRef,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import { RpcServer } from "effect/rpc";
import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import {
  CallReply,
  CodeEngineFailed,
  CodeRpcs,
  Outcome,
  type Program,
  RunEvent,
} from "./protocol.ts";

/** Heap for a program's values. */
const memoryLimitBytes = 128 * 1024 * 1024;
/** QuickJS's own stack check; a deeper limit let recursion overflow the thread's stack first. */
const maxStackBytes = 256 * 1024;
/** Console output kept per program; the lines past it are only counted. */
const maxLogLines = 200;
const maxLogCharacters = 16_000;
/** The longest JSON text a program may return. */
const maxValueCharacters = 64_000;
/** The file name QuickJS gives the program in stack traces. */
const programFile = "program.ts";

/** A JavaScript error as QuickJS dumps it. */
const DumpedError = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  stack: Schema.optionalKey(Schema.String),
});
const decodeDumpedError = Schema.decodeUnknownOption(DumpedError);
const jsonText = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The program as one script. Its code becomes the body of `__program`, one line below the top, so a
 * line of the script is the line of the code plus one. Each function calls out through `__call` with
 * JSON text both ways, which keeps values plain across the boundary; a failed call rejects with the
 * error the program sees.
 */
const scriptOf = (program: Program) =>
  Result.try({
    try: () =>
      transform(`async function __program() {\n${program.code}\n}`, {
        transforms: ["typescript"],
        disableESTransforms: true,
      }).code,
    catch: (cause) => cause,
  }).pipe(
    Result.map((body) =>
      [
        body,
        ...program.functions.map(
          (name) =>
            `async function external_${name}(input) {\n` +
            `  const value = await __call(${JSON.stringify(name)}, JSON.stringify(input === undefined ? {} : input));\n` +
            `  return value === undefined ? undefined : JSON.parse(value);\n` +
            `}`,
        ),
        // The input's JSON text as a string literal, which the program parses: written as an object
        // literal, a `__proto__` key would set the object's prototype instead.
        `const input = JSON.parse(${JSON.stringify(JSON.stringify(program.input))});`,
        `(async () => { const value = await __program(); return value === undefined ? undefined : JSON.stringify(value); })()`,
      ].join("\n"),
    ),
  );

/** Sucrase reports `(line:column)` of the script; the program's own line is one less. */
const SyntaxProblem = Schema.Struct({
  message: Schema.String,
  loc: Schema.Struct({ line: Schema.Finite }),
});
const syntaxOutcome = (cause: unknown, logs: LogBook) =>
  Option.match(Schema.decodeUnknownOption(SyntaxProblem)(cause), {
    onNone: () =>
      Outcome.cases.Threw.make({
        name: "SyntaxError",
        message: "The code does not parse.",
        ...logs.read(),
      }),
    onSome: ({ message, loc }) =>
      Outcome.cases.Threw.make({
        name: "SyntaxError",
        message: message.replace(
          /\((\d+):(\d+)\)$/,
          (_, line, column) => `(${line - 1}:${column})`,
        ),
        line: loc.line - 1,
        ...logs.read(),
      }),
  });

/** The line of the program's code where an error was thrown, from QuickJS's stack trace. */
const lineOf = (stack: string | undefined) =>
  Option.fromNullishOr(/at __program \(program\.ts:(\d+)/.exec(stack ?? "")?.[1]).pipe(
    Option.map((line) => Number(line) - 1),
  );

/** A value of the program as console text: a string as it is, anything else as JSON. */
const textOf = (vm: QuickJSContext, handle: QuickJSHandle) =>
  vm.typeof(handle) === "string"
    ? vm.getString(handle)
    : Option.getOrElse(jsonText(vm.dump(handle)), () => vm.typeof(handle));

/** The program threw `thrown`: an error, or any other value (`throw "x"`). */
const threwOutcome = (vm: QuickJSContext, thrown: QuickJSHandle, logs: LogBook) =>
  Option.match(decodeDumpedError(vm.dump(thrown)), {
    onNone: () =>
      Outcome.cases.Threw.make({ name: "Error", message: textOf(vm, thrown), ...logs.read() }),
    onSome: (error) =>
      Outcome.cases.Threw.make({
        name: error.name ?? "Error",
        message: error.message ?? "",
        ...Option.match(lineOf(error.stack), { onNone: () => ({}), onSome: (line) => ({ line }) }),
        ...logs.read(),
      }),
  });

/** QuickJS itself failed under the program (a lost handle, an aborted module). */
const engineOutcome = () =>
  Outcome.cases.Threw.make({
    name: "InternalError",
    message: "The sandbox's engine failed while the program ran.",
    logs: [],
    dropped: 0,
  });

/** Console lines up to the limit; the ones past it are counted, not kept. */
interface LogBook {
  readonly write: (line: string) => void;
  readonly read: () => { readonly logs: readonly string[]; readonly dropped: number };
}
const logBook = (): LogBook => {
  const lines: string[] = [];
  // The sandbox's console calls back synchronously.
  const characters = MutableRef.make(0);
  const dropped = MutableRef.make(0);
  return {
    write: (line) => {
      if (
        lines.length >= maxLogLines ||
        MutableRef.get(characters) + line.length > maxLogCharacters
      )
        MutableRef.increment(dropped);
      else {
        lines.push(line);
        MutableRef.update(characters, (count) => count + line.length);
      }
    },
    read: () => ({ logs: [...lines], dropped: MutableRef.get(dropped) }),
  };
};

/** `console.log` and its kin: strings as they are, other values as JSON. */
const installConsole = (vm: QuickJSContext, logs: LogBook) => {
  const console = vm.newObject();
  (
    [
      ["log", ""],
      ["info", ""],
      ["warn", "warn: "],
      ["error", "error: "],
    ] as const
  ).forEach(([method, prefix]) => {
    const write = vm.newFunction(method, (...args: QuickJSHandle[]) => {
      logs.write(`${prefix}${args.map((arg) => textOf(vm, arg)).join(" ")}`);
    });
    vm.setProp(console, method, write);
    write.dispose();
  });
  vm.setProp(vm.global, "console", console);
  console.dispose();
};

/** Settles a call in the program: with its result's JSON text, or with the error it throws. */
const settleCall = (vm: QuickJSContext, pending: QuickJSDeferredPromise, reply: CallReply) =>
  CallReply.match(reply, {
    Returned: ({ value }) =>
      Option.match(Option.fromUndefinedOr(value), {
        onNone: () => pending.resolve(),
        onSome: (json) => {
          const text = vm.newString(json);
          pending.resolve(text);
          text.dispose();
        },
      }),
    Failed: ({ message }) => {
      const error = vm.newError(message);
      pending.reject(error);
      error.dispose();
    },
  });

/** An evaluation's result as a Result: the value, or what was thrown. */
const settledOf = (result: DisposableResult<QuickJSHandle, QuickJSHandle>) =>
  result.error === undefined ? Result.succeed(result.value) : Result.fail(result.error);

/** The program returned: its wrapper hands back JSON text, or nothing for `undefined`. */
const returnedOutcome = (vm: QuickJSContext, returned: QuickJSHandle, logs: LogBook) => {
  if (vm.typeof(returned) !== "string") return Outcome.cases.Returned.make(logs.read());
  const value = vm.getString(returned);
  return value.length > maxValueCharacters
    ? Outcome.cases.Threw.make({
        name: "RangeError",
        message: `The returned value is ${value.length} characters as JSON, more than the ${maxValueCharacters} a program may return. Return less: filter, count or summarize in the program.`,
        ...logs.read(),
      })
    : Outcome.cases.Returned.make({ value, ...logs.read() });
};

type RunQueue = Queue.Queue<RunEvent, CodeEngineFailed | Cause.Done>;

const handlers = CodeRpcs.toLayer(
  Effect.gen(function* () {
    // A worker runs one program; the replies its calls wait for arrive through `Reply`.
    const waiting = yield* Ref.make(HashMap.empty<number, Deferred.Deferred<CallReply>>());
    const nextCall = yield* Ref.make(0);
    const engine = yield* Effect.cached(
      nativePromise(() => newQuickJSWASMModuleFromVariant(variant)).pipe(
        Effect.tapCause((cause) => Effect.logError("Code engine failed to load", cause)),
        Effect.mapError(() => CodeEngineFailed.make({})),
      ),
    );

    /** One call of the program: announced on the stream, answered through `Reply`. */
    const callOut = (queue: RunQueue, name: string, args: string) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextCall, (count) => count + 1);
        const reply = yield* Deferred.make<CallReply>();
        yield* Ref.update(waiting, HashMap.set(id, reply));
        yield* Queue.offer(queue, RunEvent.cases.Call.make({ id, name, args }));
        return yield* Deferred.await(reply);
      });

    const execute = (script: string, program: Program, queue: RunQueue, logs: LogBook) =>
      Effect.gen(function* () {
        const QuickJS = yield* engine;
        const runtime = QuickJS.newRuntime();
        runtime.setMemoryLimit(memoryLimitBytes);
        runtime.setMaxStackSize(maxStackBytes);
        const deadline = (yield* Clock.currentTimeMillis) + program.timeoutMs;
        runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
        const vm = runtime.newContext();
        installConsole(vm, logs);

        // Nothing is disposed: the worker is stopped after the program, which frees the engine
        // with it, and freeing a runtime while a call still waits aborts the engine.
        const ended = yield* Ref.make(false);
        /** Runs the program's continuations once a call it waits on is answered. */
        const pump = () => {
          runtime.executePendingJobs().error?.dispose();
        };
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const call = vm.newFunction("__call", (name: QuickJSHandle, args: QuickJSHandle) => {
          const pending = vm.newPromise();
          // Promise boundary for QuickJS: the guest awaits a promise the host settles.
          void runPromise(
            callOut(queue, vm.getString(name), vm.getString(args)).pipe(
              Effect.flatMap((reply) =>
                Effect.sync(() => {
                  settleCall(vm, pending, reply);
                  pump();
                }).pipe(Effect.when(Effect.map(Ref.get(ended), (over) => !over))),
              ),
            ),
          );
          return pending.handle;
        });
        vm.setProp(vm.global, "__call", call);
        call.dispose();

        const awaitProgram = (promise: QuickJSHandle) =>
          Effect.gen(function* () {
            const settled = vm.resolvePromise(promise);
            pump();
            const remaining = deadline - (yield* Clock.currentTimeMillis);
            const done = yield* nativePromise(() => settled).pipe(
              // QuickJS settles this promise with the program's result; it never rejects.
              Effect.orDie,
              Effect.timeoutOption(Duration.millis(Math.max(0, remaining))),
            );
            return Option.match(done, {
              onNone: () => Outcome.cases.TimedOut.make(logs.read()),
              onSome: (result) =>
                Result.match(settledOf(result), {
                  onSuccess: (value) => returnedOutcome(vm, value, logs),
                  onFailure: (error) => threwOutcome(vm, error, logs),
                }),
            });
          }).pipe(Effect.ensuring(Ref.set(ended, true)));
        return yield* Result.match(settledOf(vm.evalCode(script, programFile)), {
          onSuccess: awaitProgram,
          onFailure: (error) => Effect.succeed(threwOutcome(vm, error, logs)),
        });
      });

    const run = (program: Program, queue: RunQueue) => {
      const logs = logBook();
      return Result.match(scriptOf(program), {
        onSuccess: (script) => execute(script, program, queue, logs),
        onFailure: (cause) => Effect.succeed(syntaxOutcome(cause, logs)),
      });
    };

    return CodeRpcs.of({
      Run: (program) =>
        Stream.callback<RunEvent, CodeEngineFailed>((queue) =>
          run(program, queue).pipe(
            // The engine's own failures end the program too; the cause stays in this worker's log.
            Effect.catchDefect((defect) =>
              Effect.as(Effect.logError("Code engine failed", defect), engineOutcome()),
            ),
            Effect.flatMap((outcome) =>
              Queue.offer(queue, RunEvent.cases.Finished.make({ outcome })),
            ),
            Effect.andThen(Queue.end(queue)),
            Effect.catch((error) => Queue.fail(queue, error)),
          ),
        ),
      Reply: ({ id, reply }) =>
        Ref.modify(waiting, (current) => [
          HashMap.get(current, id),
          HashMap.remove(current, id),
        ]).pipe(
          Effect.flatMap((deferred) =>
            Effect.transposeOption(Option.map(deferred, Deferred.succeed(reply))),
          ),
          Effect.asVoid,
        ),
    });
  }),
);

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
const server = RpcServer.layer(CodeRpcs).pipe(Layer.provide(handlers), Layer.provide(protocol));

await runNativeEffect(Layer.launch(server));
