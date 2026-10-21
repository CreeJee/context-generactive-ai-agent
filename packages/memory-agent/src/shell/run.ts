import { Function as EffectFunction } from "effect";
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Match,
  MutableHashSet,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PlatformError } from "effect";
import { runOAuthNodeEffect } from "../oauth/node-runtime.ts";
import { shellInvocation } from "../runtime/host.ts";

/** Output bytes kept from the start of each stream once it is too long. */
const headBytes = 8 * 1024;
/** Output bytes kept from the end of each stream; failures usually print last. */
const tailBytes = 56 * 1024;
/** Grace period between SIGTERM and SIGKILL when stopping a command. */
const killGraceMs = 3_000;
/** Final wait for the output pipes after the process group stopped, before detached pipes are abandoned. */
const closeGraceMs = 100;

interface ActiveCommand {
  readonly cancel: () => void;
  readonly force: () => void;
}

interface ShellProcessState {
  readonly activeCommands: MutableHashSet.MutableHashSet<ActiveCommand>;
  exitListenerInstalled: boolean;
}

declare global {
  var __contextGeneractiveAgentShellProcessState: ShellProcessState | undefined;
}

// The server bundle can contain this module more than once, and development module reloads can
// evaluate it again. Keep one registry on the process global so every copy shares one exit hook.
const shellProcessState = (globalThis.__contextGeneractiveAgentShellProcessState ??= {
  activeCommands: MutableHashSet.empty<ActiveCommand>(),
  exitListenerInstalled: false,
});
const activeCommands = shellProcessState.activeCommands;

/** Stops every shell command owned by this process, normally during server shutdown. */
export function stopAllCommands(force = false) {
  for (const command of activeCommands) (force ? command.force : command.cancel)();
}

// The app installs graceful signal handlers. Its eventual process.exit reaches this final,
// synchronous safety net even if runtime disposal did not propagate an AbortSignal to a tool.
if (!shellProcessState.exitListenerInstalled) {
  shellProcessState.exitListenerInstalled = true;
  process.once("exit", () => stopAllCommands(true));
}

export const defaultTimeoutSeconds = 120;
export const maxTimeoutSeconds = 1_800;

/**
 * Environment variable names that usually hold secrets. They are not passed to commands, so a
 * command cannot print them into the conversation (R14). Tools that need a credential find it
 * through their own config or keychain, as they would in a fresh terminal.
 */
const secretVariable =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|SESSION_?KEY|AUTH)/i;

export function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && !secretVariable.test(name)) env[name] = value;
  return {
    ...env,
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The shell a command runs in: the user's login shell or `/bin/sh`, `cmd.exe` on Windows. */
export function hostShell(source: NodeJS.ProcessEnv) {
  return Effect.map(shellInvocation("", source), (invocation) => invocation.file);
}

/** Keeps the first and last bytes of a stream and counts what was dropped in between. */
const makeCapture = () => {
  let head = Buffer.alloc(0);
  const tailChunks: Uint8Array[] = [];
  let tailLength = 0;
  let total = 0;

  const push = (input: Uint8Array) => {
    let chunk = input;
    total += chunk.length;
    if (head.length < headBytes) {
      const room = headBytes - head.length;
      head = Buffer.concat([head, chunk.subarray(0, room)]);
      chunk = chunk.subarray(room);
    }
    if (chunk.length === 0) return;
    tailChunks.push(chunk);
    tailLength += chunk.length;
    while (tailLength - (tailChunks[0]?.length ?? 0) >= tailBytes) {
      tailLength -= tailChunks.shift()!.length;
    }
  };

  const result = () => {
    let tail = Buffer.concat(tailChunks);
    if (tail.length > tailBytes) tail = tail.subarray(tail.length - tailBytes);
    const omitted = total - head.length - tail.length;
    const text =
      omitted > 0
        ? `${head.toString("utf8")}\n… ${omitted} bytes omitted …\n${tail.toString("utf8")}`
        : Buffer.concat([head, tail]).toString("utf8");
    return { text, truncated: omitted > 0, bytes: total };
  };
  return { push, result };
};

export interface CommandResult {
  readonly command: string;
  readonly shell: string;
  /** `succeeded` is exit code 0; `failed` is any other exit or a signal. */
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly signal: AbortSignal | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Runs one command line on the host, in its own process group on POSIX. Timeout and cancellation
 * stop everything it started (SIGTERM, then SIGKILL; the whole tree at once on Windows). This is
 * host execution: path rules do not sandbox it.
 */
export const runCommand: {
  (options: CommandOptions): (command: string) => ReturnType<typeof runCommandBody>;
} & typeof runCommandBody = EffectFunction.dual(2, runCommandBody);
const SpawnFailed = Schema.TaggedStruct("SpawnFailed", {});

export class CommandStartFailed extends Schema.TaggedError<CommandStartFailed>()(
  "CommandStartFailed",
  { reason: SpawnFailed, cause: Schema.Defect() },
) {}

/** How a running command ended: the process exited and its pipes closed, or it was stopped. */
type CommandOutcome = Data.TaggedEnum<{
  Finished: { readonly status: ChildProcessSpawner.ExitStatus };
  Stopped: { readonly reason: "timed_out" | "cancelled" };
}>;
const CommandOutcome = Data.taggedEnum<CommandOutcome>();

function runCommandBody(command: string, options: CommandOptions): Promise<CommandResult> {
  // Register the request before asynchronous runtime/host-shell resolution so shutdown cannot miss it.
  const pending = new AbortController();
  const entry: ActiveCommand = { cancel: () => pending.abort(), force: () => pending.abort() };
  MutableHashSet.add(activeCommands, entry);
  const signal =
    options.signal === undefined
      ? pending.signal
      : AbortSignal.any([pending.signal, options.signal]);
  return runOAuthNodeEffect(runCommandEffect({ command, ...options, signal })).finally(() => {
    MutableHashSet.remove(activeCommands, entry);
  });
}

const isAborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

export const runCommandEffect = (options: CommandOptions & { readonly command: string }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { command } = options;
      const effectClock = yield* Clock.Clock;
      const invocation = yield* shellInvocation(command, options.env);
      const shell = invocation.file;
      const started = effectClock.currentTimeMillisUnsafe();
      const stdout = makeCapture();
      const stderr = makeCapture();
      const result = (
        status: CommandResult["status"],
        exitCode: number | null,
        signal: string | null,
      ): CommandResult => {
        const out = stdout.result();
        const err = stderr.result();
        return {
          command,
          shell,
          status,
          exitCode,
          signal,
          durationMs: effectClock.currentTimeMillisUnsafe() - started,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
        };
      };
      if (isAborted(options.signal)) return { ...result("cancelled", null, null), durationMs: 0 };

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(shell, [...invocation.args], {
            cwd: options.cwd,
            env: commandEnvironment(options.env),
            extendEnv: false,
            // Its own process group on POSIX, so stopping it reaches everything it started.
            detached: process.platform !== "win32",
            windowsHide: true,
            windowsVerbatimArguments: invocation.verbatim,
            stdin: "ignore",
            killSignal: "SIGTERM",
            forceKillAfter: Duration.millis(killGraceMs),
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            CommandStartFailed.make({ reason: SpawnFailed.make({}), cause }),
          ),
        );

      const stopRequested = yield* Deferred.make<void>();
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const active: ActiveCommand = {
        cancel: () => Deferred.doneUnsafe(stopRequested, Effect.void),
        // Process exit cannot wait: the kill starts synchronously and the process ends after it.
        force: () => {
          runFork(handle.kill({ killSignal: "SIGKILL" }));
        },
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => MutableHashSet.add(activeCommands, active)),
        () => Effect.sync(() => MutableHashSet.remove(activeCommands, active)),
      );
      const onAbort = () => active.cancel();
      yield* Effect.acquireRelease(
        Effect.sync(() => options.signal?.addEventListener("abort", onAbort, { once: true })),
        () => Effect.sync(() => options.signal?.removeEventListener("abort", onAbort)),
      );
      // Close the abort-listener registration race after the child is tracked.
      if (isAborted(options.signal)) onAbort();

      const drain = (
        output: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
        capture: typeof stdout,
      ) =>
        output.pipe(
          Stream.runForEach((chunk) => Effect.sync(() => capture.push(chunk))),
          Effect.forkScoped,
        );
      const pipes = yield* Effect.all([drain(handle.stdout, stdout), drain(handle.stderr, stderr)]);
      const drained = Fiber.joinAll(pipes);

      const outcome = yield* Effect.raceAll([
        // Done once the process exited and every pipe it shared closed.
        Effect.all([handle.exitStatus, drained]).pipe(
          Effect.map(([status]) => CommandOutcome.Finished({ status })),
        ),
        Effect.sleep(Duration.seconds(options.timeoutSeconds)).pipe(
          Effect.as(CommandOutcome.Stopped({ reason: "timed_out" })),
        ),
        Deferred.await(stopRequested).pipe(
          Effect.as(CommandOutcome.Stopped({ reason: "cancelled" })),
        ),
      ]);
      const stop = Effect.fnUntraced(function* (reason: "timed_out" | "cancelled") {
        // SIGTERM to the group, then SIGKILL after the grace period. Nothing is left to signal
        // once the leader exited and its group is gone.
        yield* handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.millis(killGraceMs) })
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.filterOrFail(
                handle.isRunning,
                (running) => !running,
                () => error,
              ),
            ),
          );
        // A detached descendant can keep the pipes after its group stopped: stop waiting.
        yield* drained.pipe(Effect.timeoutOption(Duration.millis(closeGraceMs)));
        const status = yield* handle.exitStatus.pipe(
          Effect.timeoutOption(Duration.millis(closeGraceMs)),
        );
        return { status, reason };
      });
      const ended = yield* CommandOutcome.$match(outcome, {
        Finished: ({ status }) => Effect.succeed({ status: Option.some(status), reason: null }),
        Stopped: ({ reason }) => stop(reason),
      });
      const exit = Option.match(ended.status, {
        onNone: () => ({ exitCode: null, signal: null }),
        onSome: Match.valueTags({
          Exited: (status) => ({ exitCode: Number(status.code), signal: null }),
          Signaled: (status) => ({ exitCode: null, signal: status.signal }),
        }),
      });
      return result(
        ended.reason ?? (exit.exitCode === 0 ? "succeeded" : "failed"),
        exit.exitCode,
        exit.signal,
      );
    }),
  );
