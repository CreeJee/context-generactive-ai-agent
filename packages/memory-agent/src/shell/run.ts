import { spawn } from "node:child_process";
import { shellInvocation, stopProcessTree } from "../runtime/host.ts";

/** Output bytes kept from the start of each stream once it is too long. */
const headBytes = 8 * 1024;
/** Output bytes kept from the end of each stream; failures usually print last. */
const tailBytes = 56 * 1024;
/** Grace period between SIGTERM and SIGKILL when stopping a command. */
const killGraceMs = 3_000;
/** Final wait for Node's close event after SIGKILL before detached pipes are abandoned. */
const closeGraceMs = 500;

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
class Capture {
  #head = Buffer.alloc(0);
  #tail: Buffer[] = [];
  #tailLength = 0;
  #total = 0;

  push(chunk: Buffer) {
    this.#total += chunk.length;
    if (this.#head.length < headBytes) {
      const room = headBytes - this.#head.length;
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, room)]);
      chunk = chunk.subarray(room);
    }
    if (chunk.length === 0) return;
    this.#tail.push(chunk);
    this.#tailLength += chunk.length;
    while (this.#tailLength - (this.#tail[0]?.length ?? 0) >= tailBytes) {
      this.#tailLength -= this.#tail.shift()!.length;
    }
  }

  result() {
    let tail = Buffer.concat(this.#tail);
    if (tail.length > tailBytes) tail = tail.subarray(tail.length - tailBytes);
    const omitted = this.#total - this.#head.length - tail.length;
    const text =
      omitted > 0
        ? `${this.#head.toString("utf8")}\n… ${omitted} bytes omitted …\n${tail.toString("utf8")}`
        : Buffer.concat([this.#head, tail]).toString("utf8");
    return { text, truncated: omitted > 0, bytes: this.#total };
  }
}

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
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const invocation = shellInvocation(command, options.env);
  const shell = invocation.file;
  const windows = process.platform === "win32";
  const started = Date.now();
  const stdout = new Capture();
  const stderr = new Capture();

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        command,
        shell,
        status: "cancelled",
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    const child = spawn(shell, [...invocation.args], {
      cwd: options.cwd,
      env: commandEnvironment(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      // A process group to stop on POSIX; on Windows `detached` would open a console window.
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
    });
    let stopReason: "timed_out" | "cancelled" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const timeout = setTimeout(() => stop("timed_out"), options.timeoutSeconds * 1000);
    const onAbort = () => stop("cancelled");

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        command,
        shell,
        status: stopReason ?? (exitCode === 0 ? "succeeded" : "failed"),
        exitCode,
        signal,
        durationMs: Date.now() - started,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    };
    const abandonPipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      finish(child.exitCode, child.signalCode);
    };
    const force = (pid: number) => {
      stopProcessTree(pid, true);
      closeTimer = setTimeout(abandonPipes, closeGraceMs);
    };
    function stop(reason: "timed_out" | "cancelled") {
      if (stopReason || child.pid === undefined) return;
      stopReason = reason;
      const pid = child.pid;
      // The shell leader may already have exited while a detached descendant still owns its pipes.
      // Signal the original group anyway, then stop waiting for pipes that escaped that group.
      stopProcessTree(pid, false);
      killTimer = setTimeout(() => force(pid), killGraceMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", finish);
  });
}
