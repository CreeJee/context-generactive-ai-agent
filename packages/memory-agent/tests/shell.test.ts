import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Either } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { commandEnvironment, runCommand, stopAllCommands } from "../src/shell/run.ts";
import { resolveShellWorkingDirectory } from "../src/tools/approved.ts";

const holdStdio = fileURLToPath(new URL("./support/hold-stdio.mjs", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workdir() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-shell-")));
  directories.push(directory);
  return directory;
}

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
  test("installs one exit listener across duplicate module evaluations", async () => {
    const listeners = process.listenerCount("exit");
    await import(new URL("../src/shell/run.ts?duplicate=1", import.meta.url).href);
    await import(new URL("../src/shell/run.ts?duplicate=2", import.meta.url).href);
    expect(process.listenerCount("exit")).toBe(listeners);
  });

  test("allows shell experiments below /tmp but not arbitrary absolute workdirs", () => {
    const project = workdir();
    const storage = workdir();
    const scratch = workdir();
    const allowed = resolveShellWorkingDirectory(project, storage, scratch);
    expect(Either.isRight(allowed)).toBe(true);
    if (Either.isRight(allowed)) expect(allowed.right.absolute).toBe(scratch);

    const refused = resolveShellWorkingDirectory(project, storage, "/usr");
    expect(Either.isLeft(refused)).toBe(true);
    if (Either.isLeft(refused)) expect(refused.left.reason).toBe("invalid_path");
  });

  test("reports output, exit code and the working directory", async () => {
    const cwd = workdir();
    const ok = await runCommand("pwd; printf 'err' >&2", options(cwd));
    expect(ok).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      stdout: `${cwd}\n`,
      stderr: "err",
      stdoutTruncated: false,
    });
    expect(await runCommand("exit 3", options(cwd))).toMatchObject({
      status: "failed",
      exitCode: 3,
    });
  });

  test("keeps the start and end of long output", async () => {
    const result = await runCommand(
      "printf 'START'; head -c 200000 /dev/zero | tr '\\0' x; printf 'END'",
      options(workdir()),
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.startsWith("START")).toBe(true);
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stdout).toContain("bytes omitted");
    expect(result.stdout.length).toBeLessThan(70_000);
  });

  test("stops the whole process group on timeout and on cancellation", async () => {
    const cwd = workdir();
    const timedOut = await runCommand("sleep 30 & sleep 30; wait", {
      ...options(cwd),
      timeoutSeconds: 1,
    });
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.durationMs).toBeLessThan(5_000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await runCommand("sleep 30", { ...options(cwd), signal: controller.signal });
    expect(cancelled.status).toBe("cancelled");
  });

  test("cancels active commands during server shutdown", async () => {
    const running = runCommand("sleep 30", options(workdir()));
    stopAllCommands();
    expect(await running).toMatchObject({ status: "cancelled" });
  });

  test("settles after timeout when a detached Node child keeps the output pipes open", async () => {
    const cwd = workdir();
    const pidFile = join(cwd, "detached.pid");
    let pid: number | null = null;
    try {
      const result = await runCommand(
        [process.execPath, holdStdio, pidFile].map((part) => JSON.stringify(part)).join(" "),
        { ...options(cwd), timeoutSeconds: 0.5 },
      );
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(result.status).toBe("timed_out");
      expect(result.durationMs).toBeLessThan(4_500);
    } finally {
      if (pid !== null)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The child already stopped.
        }
    }
  }, 8_000);

  test("does not pass secret-looking variables to commands", async () => {
    const env = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/sh",
      GITHUB_TOKEN: "ghp_secret",
      OPENAI_API_KEY: "sk-secret",
      PLAIN_SETTING: "visible",
    };
    expect(Object.keys(commandEnvironment(env))).not.toContain("GITHUB_TOKEN");
    const result = await runCommand("env", options(workdir(), env));
    expect(result.stdout).toContain("PLAIN_SETTING=visible");
    expect(result.stdout).not.toContain("secret");
  });
});
