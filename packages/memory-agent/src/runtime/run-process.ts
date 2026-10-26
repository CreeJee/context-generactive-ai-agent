import { Cause, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runOAuthNodeEffect } from "../oauth/node-runtime.ts";

interface CommandOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

export function runProcess(
  options: CommandOptions & {
    readonly command: string;
    readonly args: readonly string[];
  },
) {
  const { command, args } = options;
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.when(Effect.interrupt, Effect.succeed(options.signal?.aborted === true));
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd: options.cwd,
          detached: false,
          windowsHide: true,
          forceKillAfter: "5 seconds",
          stdin: "ignore",
        }),
      );
      const collect = Effect.fnUntraced(function* (stream: typeof child.stdout) {
        const decoder = new TextDecoder();
        let size = 0;
        let output = "";
        yield* stream.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              if (size > (options.maxBuffer ?? 1024 * 1024))
                return yield* new Cause.UnknownError(new Error("command_output_limit"));
              output += decoder.decode(chunk, { stream: true });
            }),
          ),
        );
        return output + decoder.decode();
      });
      const [stdout, stderr, exit] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      yield* Effect.when(
        Effect.fail(new Cause.UnknownError(new Error(`Command failed: ${command} (exit ${exit})`))),
        Effect.succeed(exit !== 0),
      );
      return { stdout, stderr };
    }),
  );
  const bounded =
    options.timeout === undefined ? program : program.pipe(Effect.timeout(options.timeout));
  const signal = options.signal;
  const owned =
    signal === undefined
      ? bounded
      : Effect.raceFirst(
          bounded,
          Effect.callback<never>((resume) => {
            const abort = () => resume(Effect.interrupt);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }),
        );
  return runOAuthNodeEffect(owned);
}
