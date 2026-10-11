import { NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, ManagedRuntime } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtime = ManagedRuntime.make(NodeServices.layer);
const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* Config.String("HOME");
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["scripts/dev.ts", ...process.argv.slice(2)], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        CONTEXT_AGENT_HOME: `${root}.rrsi-local/runtime`,
        CONTEXT_AGENT_DEV_WEB_PORT: "5174",
        CONTEXT_AGENT_DEV_BACKEND_PORT: "5181",
        CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE: `${home}/.context-generactive-agent`,
        CONTEXT_AGENT_RRSI_REPOSITORY: root,
      },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      forceKillAfter: 5_000,
    }),
  );
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => () => {
    void runtime.runPromise(
      child.kill({ killSignal: signal, forceKillAfter: 5_000 }).pipe(Effect.ignore),
    );
  });
  signals.forEach((signal, index) => process.once(signal, handlers[index]!));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => signals.forEach((signal, index) => process.off(signal, handlers[index]!))),
  );
  const code = yield* child.exitCode;
  process.exitCode = code >= 128 ? 1 : code;
}).pipe(
  Effect.scoped,
  Effect.catch((error) =>
    Console.error(String(error)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
);
await runtime.runPromise(program);
await runtime.dispose();
