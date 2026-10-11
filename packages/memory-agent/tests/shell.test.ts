import { Cause, Effect, Fiber, FileSystem, Path, Result, Schedule, Schema } from "effect";
import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { describe, expect } from "vite-plus/test";
import { commandEnvironment, runCommand, stopAllCommands } from "../src/shell/run.ts";
import { resolveShellWorkingDirectory } from "../src/tools/approved.ts";

const sdkCall = Effect.fn("shellTest.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const command = Effect.fn("shellTest.command")(function* (
  text: string,
  settings: Parameters<typeof runCommand>[1],
) {
  let running: ReturnType<typeof runCommand> | undefined;
  // The Promise boundary receives Fiber cancellation, independently of the fixture Scope.
  return yield* Effect.tryPromise({
    try: (signal) => {
      running = runCommand(text, {
        ...settings,
        signal: settings.signal === undefined ? signal : AbortSignal.any([signal, settings.signal]),
      });
      return running;
    },
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        running === undefined
          ? Promise.resolve()
          : running.then(
              () => undefined,
              () => undefined,
            ),
      ),
    ),
  );
});
const workdir = Effect.fn("shellTest.workdir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-shell-" }));
});

const options = (
  cwd: string,
  env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
) => ({
  cwd,
  timeoutSeconds: 10,
  signal: undefined,
  env,
});

describe("runCommand", () => {
  it.live("interrupting the owning Fiber waits for native command settlement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* workdir();
      const running = yield* Effect.forkChild(
        command("printf ready > started; sleep 30", options(cwd)),
      );
      yield* fs
        .exists(path.join(cwd, "started"))
        .pipe(
          Effect.repeat({ while: (started) => !started, schedule: Schedule.spaced("20 millis") }),
          Effect.timeout("1000 millis"),
        );
      yield* Fiber.interrupt(running);
      expect((yield* Fiber.await(running))._tag).toBe("Failure");
    }).pipe(withTestPlatform),
  );

  it.live("installs one exit listener across duplicate module evaluations", () =>
    Effect.gen(function* () {
      const listeners = process.listenerCount("exit");
      yield* sdkCall(
        () => import(new URL("../src/shell/run.ts?duplicate=1", import.meta.url).href),
      );
      yield* sdkCall(
        () => import(new URL("../src/shell/run.ts?duplicate=2", import.meta.url).href),
      );
      expect(process.listenerCount("exit")).toBe(listeners);
    }).pipe(withTestPlatform),
  );

  it.live("allows shell experiments below /tmp but not arbitrary absolute workdirs", () =>
    Effect.gen(function* () {
      const project = yield* workdir();
      const storage = yield* workdir();
      const scratch = yield* workdir();
      const allowed = resolveShellWorkingDirectory(project, storage, scratch);
      expect(Result.isSuccess(allowed)).toBe(true);
      if (Result.isSuccess(allowed)) expect(allowed.success.absolute).toBe(scratch);
      const refused = resolveShellWorkingDirectory(project, storage, "/usr");
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure.reason).toBe("invalid_path");
    }).pipe(withTestPlatform),
  );

  it.live("reports output, exit code and the working directory", () =>
    Effect.gen(function* () {
      const cwd = yield* workdir();
      const ok = yield* command("pwd; printf 'err' >&2", options(cwd));
      expect(ok).toMatchObject({
        status: "succeeded",
        exitCode: 0,
        stdout: `${cwd}\n`,
        stderr: "err",
        stdoutTruncated: false,
      });
      expect(yield* command("exit 3", options(cwd))).toMatchObject({
        status: "failed",
        exitCode: 3,
      });
    }).pipe(withTestPlatform),
  );

  it.live("keeps the start and end of long output", () =>
    Effect.gen(function* () {
      const result = yield* command(
        "printf 'START'; head -c 200000 /dev/zero | tr '\\0' x; printf 'END'",
        options(yield* workdir()),
      );
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout.startsWith("START")).toBe(true);
      expect(result.stdout.endsWith("END")).toBe(true);
      expect(result.stdout).toContain("bytes omitted");
      expect(result.stdout.length).toBeLessThan(70_000);
    }).pipe(withTestPlatform),
  );

  it.live("stops the whole process group on timeout and on cancellation", () => {
    // Represent a native SDK caller explicitly cancelling its request.
    const controller = new AbortController();
    return Effect.gen(function* () {
      const cwd = yield* workdir();
      const timedOut = yield* command("sleep 30 & sleep 30; wait", {
        ...options(cwd),
        timeoutSeconds: 0.25,
      });
      expect(timedOut.status).toBe("timed_out");
      expect(timedOut.durationMs).toBeLessThan(5_000);

      yield* Effect.forkChild(
        Effect.sleep("100 millis").pipe(Effect.andThen(Effect.sync(() => controller.abort()))),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      const cancelled = yield* command("sleep 30", { ...options(cwd), signal: controller.signal });
      expect(cancelled.status).toBe("cancelled");
    }).pipe(withTestPlatform);
  });

  it.live("cancels active commands during server shutdown", () =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(command("sleep 30", options(yield* workdir())), {
        startImmediately: true,
      });
      stopAllCommands();
      expect(yield* Fiber.join(running)).toMatchObject({ status: "cancelled" });
    }).pipe(withTestPlatform),
  );

  it.live(
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
        let pid: number | null = null;
        try {
          const result = yield* command(
            (yield* Effect.forEach([process.execPath, holdStdio, pidFile], (part) =>
              Schema.encodeEffect(Schema.fromJsonString(Schema.String))(part),
            )).join(" "),
            { ...options(cwd), timeoutSeconds: 1.5 },
          );
          pid = Number(yield* fs.readFileString(pidFile));
          expect(result.status).toBe("timed_out");
          expect(result.durationMs).toBeLessThan(4_500);
        } finally {
          if (pid !== null) {
            const stoppedPid = pid;
            yield* Effect.try(() => process.kill(stoppedPid, "SIGKILL")).pipe(Effect.ignore);
          }
        }
      }).pipe(withTestPlatform),
    8_000,
  );

  it.live("does not pass secret-looking variables to commands", () =>
    Effect.gen(function* () {
      const env = {
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/sh",
        GITHUB_TOKEN: "ghp_secret",
        OPENAI_API_KEY: "sk-secret",
        PLAIN_SETTING: "visible",
      };
      expect(Object.keys(commandEnvironment(env))).not.toContain("GITHUB_TOKEN");
      const result = yield* command("env", options(yield* workdir(), env));
      expect(result.stdout).toContain("PLAIN_SETTING=visible");
      expect(result.stdout).not.toContain("secret");
    }).pipe(withTestPlatform),
  );
});
