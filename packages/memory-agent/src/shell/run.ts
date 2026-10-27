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
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PlatformError } from "effect";
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
  Array.from(activeCommands).forEach((command) => (force ? command.force : command.cancel)());
}

// The app installs graceful signal handlers. Its eventual process.exit reaches this final,
// synchronous safety net even if runtime disposal did not interrupt a running command.
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
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([name, value]) => value !== undefined && !secretVariable.test(name),
      ),
    ),
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

/** The first and last bytes of a stream, and how many it had in all. */
interface Captured {
  readonly head: Buffer;
  readonly tailChunks: ReadonlyArray<Uint8Array>;
  readonly tailLength: number;
  readonly total: number;
}

const nothingCaptured: Captured = {
  head: Buffer.alloc(0),
  tailChunks: [],
  tailLength: 0,
  total: 0,
};

/** Drops the oldest tail chunks that the last `tailBytes` no longer reach. */
const trimmedTail = (
  chunks: ReadonlyArray<Uint8Array>,
  length: number,
): Pick<Captured, "tailChunks" | "tailLength"> => {
  const [first, ...rest] = chunks;
  return first !== undefined && length - first.length >= tailBytes
    ? trimmedTail(rest, length - first.length)
    : { tailChunks: chunks, tailLength: length };
};

/** Keeps the first and last bytes of a stream and counts what was dropped in between. */
const captured = (state: Captured, input: Uint8Array): Captured => {
  const room = Math.max(headBytes - state.head.length, 0);
  const chunk = input.subarray(room);
  const tail =
    chunk.length === 0
      ? state
      : trimmedTail([...state.tailChunks, chunk], state.tailLength + chunk.length);
  return {
    head: room > 0 ? Buffer.concat([state.head, input.subarray(0, room)]) : state.head,
    tailChunks: tail.tailChunks,
    tailLength: tail.tailLength,
    total: state.total + input.length,
  };
};

const capturedText = ({ head, tailChunks, total }: Captured) => {
  const kept = Buffer.concat(tailChunks);
  const tail = kept.subarray(Math.max(kept.length - tailBytes, 0));
  const omitted = total - head.length - tail.length;
  const text =
    omitted > 0
      ? `${head.toString("utf8")}\n… ${omitted} bytes omitted …\n${tail.toString("utf8")}`
      : Buffer.concat([head, tail]).toString("utf8");
  return { text, truncated: omitted > 0, bytes: total };
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
  readonly command: string;
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly env: NodeJS.ProcessEnv;
}

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

/**
 * Runs one command line on the host, in its own process group on POSIX. Timeout, interruption and
 * `stopAllCommands` stop everything it started (SIGTERM, then SIGKILL; the whole tree at once on
 * Windows). This is host execution: path rules do not sandbox it.
 */
export const runCommand = (options: CommandOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { command } = options;
      const invocation = yield* shellInvocation(command, options.env);
      const shell = invocation.file;
      const started = yield* Clock.currentTimeMillis;
      const stdout = yield* Ref.make(nothingCaptured);
      const stderr = yield* Ref.make(nothingCaptured);
      const result = Effect.fnUntraced(function* (
        status: CommandResult["status"],
        exitCode: number | null,
        signal: string | null,
      ): Effect.fn.Return<CommandResult> {
        const out = capturedText(yield* Ref.get(stdout));
        const err = capturedText(yield* Ref.get(stderr));
        return {
          command,
          shell,
          status,
          exitCode,
          signal,
          durationMs: (yield* Clock.currentTimeMillis) - started,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
        };
      });
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
      // The process exit hook reads this set synchronously, so it stays a native mutable set.
      yield* Effect.acquireRelease(
        Effect.sync(() => MutableHashSet.add(activeCommands, active)),
        () => Effect.sync(() => MutableHashSet.remove(activeCommands, active)),
      );
      const drain = (
        output: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
        capture: Ref.Ref<Captured>,
      ) =>
        output.pipe(
          Stream.runForEach((chunk) => Ref.update(capture, (state) => captured(state, chunk))),
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
      return yield* result(
        ended.reason ?? (exit.exitCode === 0 ? "succeeded" : "failed"),
        exit.exitCode,
        exit.signal,
      );
    }),
  );
