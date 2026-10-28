import { layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Fiber, FileSystem, Path, Result, Schedule, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  commandEnvironment,
  CommandStartFailed,
  runCommand,
  stopAllCommands,
} from "../src/shell/run.ts";
import { resolveShellWorkingDirectory } from "../src/tools/approved.ts";

const sdkCall = Effect.fn("shellTest.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const workdir = Effect.fn("shellTest.workdir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-shell-" }));
});

const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" };
const options = (cwd: string, source: NodeJS.ProcessEnv = env) => ({
  cwd,
  timeoutSeconds: 10,
  env: source,
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  describe("runCommand", () => {
    it.effect("interrupting a command drains its process group before returning", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const running = yield* runCommand({
          command: "echo $$ > child.pid; sleep 30",
          cwd,
          timeoutSeconds: 60,
          env,
        }).pipe(Effect.forkChild);
        const recorded = yield* fs
          .readFileString(path.join(cwd, "child.pid"))
          .pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }));
        const pid = yield* Schema.decodeEffect(
          Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
        )(recorded.trim());
        yield* Fiber.interrupt(running);
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      }),
    );

    it.effect("native process startup failures use the typed error channel", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          runCommand({
            command: "true",
            cwd: "/missing-context-agent-command-directory",
            timeoutSeconds: 10,
            env,
          }),
        );
        expect(failure).toBeInstanceOf(CommandStartFailed);
        expect(Schema.is(CommandStartFailed.fields.reason)(failure.reason)).toBe(true);
      }),
    );

    it.effect("defects in command preparation stay defects", () =>
      Effect.gen(function* () {
        const defect = new Error("invalid command environment implementation");
        const broken = Object.defineProperty({}, "SHELL", {
          get: () => {
            throw defect;
          },
        });
        const exit = yield* Effect.exit(
          runCommand({ command: "true", cwd: "/tmp", timeoutSeconds: 10, env: broken }),
        );
        expect(Exit.hasDies(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
      }),
    );

    it.effect("installs one exit listener across duplicate module evaluations", () =>
      Effect.gen(function* () {
        const listeners = process.listenerCount("exit");
        yield* sdkCall(
          () => import(new URL("../src/shell/run.ts?duplicate=1", import.meta.url).href),
        );
        yield* sdkCall(
          () => import(new URL("../src/shell/run.ts?duplicate=2", import.meta.url).href),
        );
        expect(process.listenerCount("exit")).toBe(listeners);
      }),
    );

    it.effect("allows shell experiments below /tmp but not arbitrary absolute workdirs", () =>
      Effect.gen(function* () {
        const project = yield* workdir();
        const storage = yield* workdir();
        const scratch = yield* workdir();
        const allowed = yield* resolveShellWorkingDirectory(project, storage, scratch).pipe(
          Effect.result,
        );
        expect(Result.isSuccess(allowed)).toBe(true);
        if (Result.isSuccess(allowed)) expect(allowed.success.absolute).toBe(scratch);
        const refused = yield* resolveShellWorkingDirectory(project, storage, "/usr").pipe(
          Effect.result,
        );
        expect(Result.isFailure(refused)).toBe(true);
        if (Result.isFailure(refused)) expect(refused.failure.reason).toBe("invalid_path");
      }),
    );

    it.effect("reports output, exit code and the working directory", () =>
      Effect.gen(function* () {
        const cwd = yield* workdir();
        const ok = yield* runCommand({ ...options(cwd), command: "pwd; printf 'err' >&2" });
        expect(ok).toMatchObject({
          status: "succeeded",
          exitCode: 0,
          stdout: `${cwd}\n`,
          stderr: "err",
          stdoutTruncated: false,
        });
        expect(yield* runCommand({ ...options(cwd), command: "exit 3" })).toMatchObject({
          status: "failed",
          exitCode: 3,
        });
      }),
    );

    it.effect("keeps the start and end of long output", () =>
      Effect.gen(function* () {
        const result = yield* runCommand({
          ...options(yield* workdir()),
          command: "printf 'START'; head -c 200000 /dev/zero | tr '\\0' x; printf 'END'",
        });
        expect(result.stdoutTruncated).toBe(true);
        expect(result.stdout.startsWith("START")).toBe(true);
        expect(result.stdout.endsWith("END")).toBe(true);
        expect(result.stdout).toContain("bytes omitted");
        expect(result.stdout.length).toBeLessThan(70_000);
      }),
    );

    it.effect("stops the whole process group on timeout", () =>
      Effect.gen(function* () {
        const timedOut = yield* runCommand({
          ...options(yield* workdir()),
          command: "sleep 30 & sleep 30; wait",
          timeoutSeconds: 0.25,
        });
        expect(timedOut.status).toBe("timed_out");
        expect(timedOut.durationMs).toBeLessThan(5_000);
      }),
    );

    it.effect("cancels active commands during server shutdown", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* workdir();
        const running = yield* Effect.forkChild(
          runCommand({ ...options(cwd), command: "printf ready > started; sleep 30" }),
        );
        yield* fs
          .exists(path.join(cwd, "started"))
          .pipe(
            Effect.repeat({ while: (started) => !started, schedule: Schedule.spaced("20 millis") }),
            Effect.timeout("1000 millis"),
          );
        stopAllCommands();
        expect(yield* Fiber.join(running)).toMatchObject({ status: "cancelled" });
      }),
    );

    it.effect(
      "settles after timeout when a detached Node child keeps the output pipes open",
      () =>
        Effect.gen(function* () {
          const cwd = yield* workdir();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const holdStdio = yield* path.fromFileUrl(
            new URL("./support/hold-stdio.ts", import.meta.url),
          );
          const pidFile = path.join(cwd, "detached.pid");
          // Kills the detached child once the test ends, if it lived long enough to write its pid.
          yield* Effect.addFinalizer(() =>
            fs.readFileString(pidFile).pipe(
              Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid), "SIGKILL"))),
              Effect.ignore,
            ),
          );
          const result = yield* runCommand({
            ...options(cwd),
            command: (yield* Effect.forEach([process.execPath, holdStdio, pidFile], (part) =>
              Schema.encodeEffect(Schema.fromJsonString(Schema.String))(part),
            )).join(" "),
            timeoutSeconds: 1.5,
          });
          expect(result.status).toBe("timed_out");
          expect(result.durationMs).toBeLessThan(4_500);
        }),
      8_000,
    );

    it.effect("does not pass secret-looking variables to commands", () =>
      Effect.gen(function* () {
        const secrets = {
          ...env,
          GITHUB_TOKEN: "ghp_secret",
          OPENAI_API_KEY: "sk-secret",
          PLAIN_SETTING: "visible",
        };
        expect(Object.keys(commandEnvironment(secrets))).not.toContain("GITHUB_TOKEN");
        const result = yield* runCommand({ ...options(yield* workdir(), secrets), command: "env" });
        expect(result.stdout).toContain("PLAIN_SETTING=visible");
        expect(result.stdout).not.toContain("secret");
      }),
    );
  });
});
