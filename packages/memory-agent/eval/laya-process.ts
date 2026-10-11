import { isTruthy } from "../src/truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import { LayaWorkerProcess } from "./laya-worker-process.ts";

/** Cold-process experiment only; never a production/local-sensor replacement. */
export const layaProvenance = {
  model: "onnx-community/laya-multilingual-ONNX",
  revision: "46b77bbf5642fec5f14e540570228a8cbe8ab81f",
  mode: "nonproduction-cold-process",
} as const;

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
export const LayaWorkerResult = Schema.Struct({
  score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  tokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 })),
  loadMs: Positive,
  inferenceMs: Positive,
  rssBytes: Positive,
});
export type LayaResult =
  | {
      readonly _tag: "success";
      readonly value: typeof LayaWorkerResult.Type;
      readonly provenance: typeof layaProvenance;
    }
  | { readonly _tag: "skip"; readonly reason: "disabled" | "resource" | "busy" }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "error"; readonly stage: "input" | "process" | "output" };

export interface LayaProcessOptions {
  readonly enabled?: boolean;
  readonly resourceAvailable: boolean;
  readonly sdkDir: string;
  readonly modelDir: string;
  readonly workerPath: string;
  readonly startupTimeoutMs?: number;
}

class WorkerFailure extends Schema.TaggedError<WorkerFailure>()("LayaWorkerFailure", {
  stage: Schema.Literals(["input", "process", "output"]),
}) {}

/** One instance per turn: retains at most one bounded text/result pair. Provide a trusted platform spawner layer. */
export const makeLayaProcess = Effect.fnUntraced(function* (options: LayaProcessOptions) {
  const busy = yield* Ref.make(false);
  const memo = yield* Ref.make<Option.Option<{ text: string; result: LayaResult }>>(Option.none());
  const run = Effect.fnUntraced(function* (
    text: string,
    resourceAllowed = true,
  ): Effect.fn.Return<LayaResult, never, LayaWorkerProcess> {
    if (!(options.enabled === true)) return { _tag: "skip", reason: "disabled" };
    if (!options.resourceAvailable || !isTruthy(resourceAllowed))
      return { _tag: "skip", reason: "resource" };
    if (process.platform !== "darwin") return { _tag: "unavailable" };
    const timeout = options.startupTimeoutMs ?? 10_000;
    if (
      text.length > 2048 ||
      !path.isAbsolute(options.sdkDir) ||
      !path.isAbsolute(options.modelDir) ||
      !path.isAbsolute(options.workerPath) ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      return { _tag: "error", stage: "input" };
    }
    const cached = yield* Ref.get(memo);
    if (Option.isSome(cached) && cached.value.text === text) return cached.value.result;
    const acquired = yield* Ref.getAndSet(busy, true);
    if (acquired) return { _tag: "skip", reason: "busy" };
    const execute = Effect.gen(function* () {
      const spawner = yield* LayaWorkerProcess;
      const stdin = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
      )({ text }).pipe(Effect.mapError(() => WorkerFailure.make({ stage: "input" })));
      const handle = yield* spawner
        .spawn({
          executable: "/usr/bin/sandbox-exec",
          args: [
            "-p",
            "(version 1)(allow default)(deny network*)",
            process.execPath,
            options.workerPath,
            options.sdkDir,
            options.modelDir,
          ],
          stdin: new TextEncoder().encode(stdin + "\n"),
        })
        .pipe(Effect.mapError(() => WorkerFailure.make({ stage: "process" })));
      // Registered after spawn: runs before the spawner scope's own finalizer.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* handle.isRunning) yield* handle.kill({ killSignal: "SIGKILL" });
          yield* handle.exitCode;
        }).pipe(Effect.orDie),
      );
      let bytes = 0;
      const chunks = yield* handle.stdout.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.length;
          return bytes <= 8192
            ? Effect.succeed(chunk)
            : Effect.fail(WorkerFailure.make({ stage: "output" }));
        }),
        Stream.decodeText(),
        Stream.runCollect,
        Effect.mapError(() => WorkerFailure.make({ stage: "output" })),
      );
      const code = yield* handle.exitCode.pipe(
        Effect.mapError(() => WorkerFailure.make({ stage: "process" })),
      );
      if (code !== 0) return yield* WorkerFailure.make({ stage: "process" });
      const value = yield* Schema.decodeEffect(Schema.fromJsonString(LayaWorkerResult))(
        chunks.join(""),
      ).pipe(Effect.mapError(() => WorkerFailure.make({ stage: "output" })));
      return { _tag: "success", value, provenance: layaProvenance } as const;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(timeout),
      Effect.map((value): LayaResult => (Option.isSome(value) ? value.value : { _tag: "timeout" })),
      Effect.catchTag("LayaWorkerFailure", (error) =>
        Effect.succeed<LayaResult>({ _tag: "error", stage: error.stage }),
      ),
    );
    return yield* execute.pipe(
      Effect.tap((result) => Ref.set(memo, Option.some({ text, result }))),
      Effect.ensuring(Ref.set(busy, false)),
    );
  });
  const runAbortable = Effect.fnUntraced(function* (
    text: string,
    signal: AbortSignal,
    resourceAllowed = true,
  ) {
    // Check at execution time, before either race branch can acquire a process.
    if (signal.aborted) return { _tag: "cancelled" } as const;
    return yield* Effect.raceFirst(
      run(text, resourceAllowed),
      Effect.callback<LayaResult>((resume) => {
        const abort = () => resume(Effect.succeed({ _tag: "cancelled" }));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }),
    );
  });
  return { run, runAbortable };
});
