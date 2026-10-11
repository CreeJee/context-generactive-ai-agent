import { NodeServices } from "@effect/platform-node";
import { Cause, Context, Effect, Layer, PlatformError, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface LayaWorkerCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: Uint8Array;
}
type ProcessFailure = Cause.UnknownError | PlatformError.PlatformError;
export interface LayaWorkerHandle {
  readonly stdout: Stream.Stream<Uint8Array, ProcessFailure>;
  readonly exitCode: Effect.Effect<number, ProcessFailure>;
  readonly isRunning: Effect.Effect<boolean, ProcessFailure>;
  readonly kill: (options: {
    readonly killSignal: "SIGKILL";
  }) => Effect.Effect<void, ProcessFailure>;
}
export class LayaWorkerProcess extends Context.Service<
  LayaWorkerProcess,
  {
    readonly spawn: (
      command: LayaWorkerCommand,
    ) => Effect.Effect<LayaWorkerHandle, ProcessFailure, Scope.Scope>;
  }
>()("memory-agent/eval/laya-worker-process/LayaWorkerProcess") {}

/** The caller opts into eval processes; no worker or SDK loads at layer construction. */
export const layaWorkerProcessLayer = Layer.effect(
  LayaWorkerProcess,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return {
      spawn: Effect.fn("LayaWorkerProcess.spawn")(function* (command: LayaWorkerCommand) {
        const child = yield* spawner.spawn(
          ChildProcess.make(command.executable, command.args, {
            env: {},
            extendEnv: false,
            stdin: Stream.make(command.stdin),
            stderr: "ignore",
            killSignal: "SIGKILL",
          }),
        );
        return {
          stdout: child.stdout,
          isRunning: child.isRunning,
          kill: child.kill,
          // The eval protocol represents signal termination as -1, matching its former null code.
          exitCode: child.exitCode.pipe(
            Effect.catchIf(
              (error) =>
                error.reason._tag === "Unknown" &&
                error.reason.method === "exitCode" &&
                error.reason.cause instanceof Error &&
                error.reason.cause.message.startsWith(
                  "Process interrupted due to receipt of signal:",
                ),
              () => Effect.succeed(-1),
            ),
          ),
        } satisfies LayaWorkerHandle;
      }),
    };
  }),
).pipe(Layer.provide(NodeServices.layer));
