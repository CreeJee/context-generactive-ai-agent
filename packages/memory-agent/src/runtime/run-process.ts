import { Cause, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface CommandOptions {
  readonly cwd?: string;
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
      const collect = (stream: typeof child.stdout) =>
        stream.pipe(
          Stream.mapAccum(
            () => 0,
            (size, chunk) => [size + chunk.byteLength, [{ chunk, size: size + chunk.byteLength }]],
          ),
          Stream.mapEffect(({ chunk, size }) =>
            Effect.as(
              Effect.when(
                Effect.fail(new Cause.UnknownError(new Error("command_output_limit"))),
                Effect.succeed(size > (options.maxBuffer ?? 1024 * 1024)),
              ),
              chunk,
            ),
          ),
          Stream.decodeText(),
          Stream.mkString,
        );
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
  return options.timeout === undefined ? program : program.pipe(Effect.timeout(options.timeout));
}
