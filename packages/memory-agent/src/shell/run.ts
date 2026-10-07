import { Function as EffectFunction } from "effect";
import { Clock, Deferred, Effect, Fiber, MutableHashSet, Option, Schema, Scope } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { spawn } from "node:child_process";
import { shellInvocation, stopProcessTree } from "../runtime/host.ts";

/** Output bytes kept from the start of each stream once it is too long. */
const headBytes = 8 * 1024;
/** Output bytes kept from the end of each stream; failures usually print last. */
const tailBytes = 56 * 1024;
/** Grace period between SIGTERM and SIGKILL when stopping a command. */
const killGraceMs = 3_000;
/** Final wait for Node's close event after SIGKILL before detached pipes are abandoned. */
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
export function hostShell(source: NodeJS.ProcessEnv): string {
  return shellInvocation("", source).file;
}

/** Keeps the first and last bytes of a stream and counts what was dropped in between. */
const makeCapture = () => {
  let head = Buffer.alloc(0);
  const tailChunks: Buffer[] = [];
  let tailLength = 0;
  let total = 0;

  const push = (input: Buffer) => {
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
export class CommandStartFailed extends Schema.TaggedError<CommandStartFailed>()(
  "CommandStartFailed",
  {
    reason: Schema.TaggedStruct("SpawnFailed", {}),
    cause: Schema.Defect(),
  },
) {}

function runCommandBody(command: string, options: CommandOptions): Promise<CommandResult> {
  return Effect.runPromise(runCommandEffect({ command, ...options }));
}

export const runCommandEffect = (options: CommandOptions & { readonly command: string }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { command } = options;
      const effectClock = yield* Clock.Clock;
      const context = yield* Effect.context<never>();
      const scope = yield* Scope.Scope;
      const later = (milliseconds: number, action: () => void): Fiber.Fiber<void> =>
        Effect.runSyncWith(context)(
          Effect.forkIn(
            Effect.sleep(milliseconds).pipe(Effect.andThen(Effect.sync(action))),
            scope,
          ),
        );
      const invocation = shellInvocation(command, options.env);
      const shell = invocation.file;
      const windows = process.platform === "win32";
      const started = effectClock.currentTimeMillisUnsafe();
      const stdout = makeCapture();
      const stderr = makeCapture();
      if (options.signal?.aborted === true)
        return {
          command,
          shell,
          status: "cancelled" as const,
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      const finished = yield* Deferred.make<void>();
      const child = yield* Effect.try({
        try: () =>
          spawn(shell, [...invocation.args], {
            cwd: options.cwd,
            env: commandEnvironment(options.env),
            stdio: ["ignore", "pipe", "pipe"],
            detached: !windows,
            windowsHide: true,
            windowsVerbatimArguments: invocation.verbatim,
          }),
        catch: (cause) => CommandStartFailed.make({ reason: { _tag: "SpawnFailed" }, cause }),
      });
      return yield* Effect.callback<CommandResult, CommandStartFailed>((resume) => {
        let stopReason: "timed_out" | "cancelled" | null = null;
        let killTimer: Fiber.Fiber<void> | undefined;
        let closeTimer: Fiber.Fiber<void> | undefined;
        let forced = false;
        let settled = false;
        let active: ActiveCommand | undefined;

        const timeout = later(options.timeoutSeconds * 1000, () => stop("timed_out"));
        const onAbort = () => stop("cancelled");

        const cleanup = () => {
          timeout.interruptUnsafe();
          if (killTimer !== undefined) killTimer.interruptUnsafe();
          if (closeTimer !== undefined) closeTimer.interruptUnsafe();
          options.signal?.removeEventListener("abort", onAbort);
          if (active !== undefined) MutableHashSet.remove(activeCommands, active);
        };
        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          const out = stdout.result();
          const err = stderr.result();
          resume(
            Effect.succeed({
              command,
              shell,
              status: stopReason ?? (exitCode === 0 ? "succeeded" : "failed"),
              exitCode,
              signal,
              durationMs: effectClock.currentTimeMillisUnsafe() - started,
              stdout: out.text,
              stderr: err.text,
              stdoutTruncated: out.truncated,
              stderrTruncated: err.truncated,
            }),
          );
          Deferred.doneUnsafe(finished, Effect.void);
        };
        const abandonPipes = () => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode, child.signalCode);
        };
        const force = (pid: number) => {
          if (forced || settled) return;
          forced = true;
          if (killTimer !== undefined) killTimer.interruptUnsafe();
          stopProcessTree(pid, true);
          closeTimer = later(closeGraceMs, abandonPipes);
        };
        function stop(reason: "timed_out" | "cancelled") {
          if (isTruthy(stopReason) || child.pid === undefined) return;
          stopReason = reason;
          const pid = child.pid;
          // The shell leader may already have exited while a detached descendant still owns its pipes.
          // Signal the original group anyway, then stop waiting for pipes that escaped that group.
          stopProcessTree(pid, false);
          if (child.exitCode !== null || child.signalCode !== null) force(pid);
          else killTimer = later(killGraceMs, () => force(pid));
        }

        active = {
          cancel: () => stop("cancelled"),
          force: () => child.pid !== undefined && stopProcessTree(child.pid, true),
        };
        MutableHashSet.add(activeCommands, active);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(
            Effect.fail(CommandStartFailed.make({ reason: { _tag: "SpawnFailed" }, cause: error })),
          );
          Deferred.doneUnsafe(finished, Effect.void);
        });
        child.once("exit", () => {
          if (isTruthy(stopReason) && child.pid !== undefined) force(child.pid);
        });
        child.once("close", finish);
        // Close the abort-listener registration race after the child is tracked.
        if (options.signal?.aborted === true) onAbort();
        return Effect.gen(function* () {
          if (!settled) {
            stop("cancelled");
            const drained = yield* Deferred.await(finished).pipe(
              Effect.timeoutOption(killGraceMs + closeGraceMs + 100),
            );
            if (Option.isNone(drained)) {
              if (child.pid !== undefined) force(child.pid);
              abandonPipes();
            }
          }
          cleanup();
        });
      });
    }),
  );
