import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { Schema } from "effect";

const inspection = Schema.Struct({
  bindings: Schema.Array(Schema.Unknown),
  operations: Schema.Array(Schema.Unknown),
  revisions: Schema.Array(Schema.Unknown),
  dispatches: Schema.Array(Schema.Unknown),
  runs: Schema.Array(Schema.Struct({ status: Schema.String })),
});
const inspect = async (owner: Owner) =>
  Schema.decodeUnknownSync(inspection)(
    await fetch(`${owner.url}/inspect`, { signal: AbortSignal.timeout(10_000) }).then((value) =>
      value.json(),
    ),
  );

type Owner = { child: ChildProcess; url: string; sessionId: string };
async function start(base: string, mode: string): Promise<Owner> {
  const child = fork(
    fileURLToPath(new URL("./fixtures/goal-owner-process.mts", import.meta.url)),
    [base, mode],
    {
      execArgv: [
        "--experimental-strip-types",
        "--import",
        fileURLToPath(new URL("./fixtures/native-test-loader.ts", import.meta.url)),
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let diagnostic = "";
  child.stderr?.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  child.stdout?.resume();
  try {
    return await new Promise<Owner>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Owner startup timeout: ${diagnostic}`)),
        15_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Owner exited ${code}: ${diagnostic}`));
      });
      child.once("message", (message: { port: number; sessionId: string }) => {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${message.port}`, sessionId: message.sessionId });
      });
    });
  } catch (error) {
    await stop(child, "SIGKILL");
    throw error;
  }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
const post = (owner: Owner, runId: string) =>
  fetch(`${owner.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: owner.sessionId,
      runId,
      messages: [{ id: "user-1", role: "user", content: "OS owner recovery" }],
      tools: [],
      context: [],
    }),
    signal: AbortSignal.timeout(10_000),
  });
async function waitForModel(base: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(base, "model-calls"))) {
    if (Date.now() > deadline) throw new Error("Fake model did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function textPrefix(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let prefix = "";
  try {
    while (!prefix.includes("completed owner turn") || !prefix.endsWith("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream ended before durable text");
      prefix += decoder.decode(chunk.value, { stream: true });
    }
    expect(prefix).toContain("TEXT_MESSAGE_CONTENT");
    expect(prefix).not.toContain("RUN_FINISHED");
    expect(prefix).not.toContain("RUN_ERROR");
    return prefix;
  } finally {
    await reader.cancel();
  }
}

test("real OS owner SIGKILL preserves durable partial text without replaying work", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-owner-partial-"));
  const children: ChildProcess[] = [];
  try {
    const first = await start(base, "partial");
    children.push(first.child);
    const runId = "partial-killed-run";
    const delivered = await textPrefix(await post(first, runId));
    const replay = (owner: Owner) =>
      fetch(`${owner.url}/api/chat?runId=${runId}&offset=-1`, {
        signal: AbortSignal.timeout(10_000),
      });
    // A second HTTP reader proves the text is journaled before OS termination.
    expect(await textPrefix(await replay(first))).toBe(delivered);
    const old = await inspect(first);
    expect(old.runs).toHaveLength(1);
    expect(old.bindings).toHaveLength(1);
    const calls = readFileSync(join(base, "model-calls"), "utf8");
    expect(calls.trim().split("\n")).toHaveLength(1);
    await stop(first.child, "SIGKILL");
    const second = await start(base, "reopen");
    children.push(second.child);
    const recovered = await inspect(second);
    expect(recovered.bindings).toEqual(old.bindings);
    expect(recovered.revisions).toEqual(old.revisions);
    expect(recovered.dispatches).toEqual(old.dispatches);
    expect(recovered.operations).toEqual(old.operations);
    expect(recovered.runs).toHaveLength(1);
    expect(recovered.runs[0].status).toBe("failed");
    expect(await textPrefix(await replay(second))).toBe(delivered);
    for (const retry of [runId, "partial-new-run-bypass"])
      expect((await post(second, retry)).status).toBe(409);
    expect(await inspect(second)).toEqual(recovered);
    expect(readFileSync(join(base, "model-calls"), "utf8")).toBe(calls);
  } finally {
    for (const child of children.reverse()) await stop(child, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
}, 40_000);

for (const interrupted of [false, true]) {
  test(`real OS owner ${interrupted ? "SIGKILL fences incomplete work" : "SIGTERM preserves completed turn"}`, async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-owner-process-"));
    const children: ChildProcess[] = [];
    try {
      const first = await start(base, interrupted ? "blocked" : "complete");
      children.push(first.child);
      const runId = interrupted ? "killed-run" : "completed-run";
      const response = await post(first, runId);
      expect(response.status).toBe(200);
      const delivered = response.text().catch(() => "");
      await waitForModel(base);
      let completed = "";
      if (!interrupted) {
        completed = await delivered;
        expect(completed).toContain("completed owner turn");
      }
      const old = await inspect(first);
      expect(old.bindings).toHaveLength(1);
      await stop(first.child, interrupted ? "SIGKILL" : "SIGTERM");
      await delivered;
      const second = await start(base, "reopen");
      children.push(second.child);
      const state = await inspect(second);
      expect(state.bindings).toEqual(old.bindings);
      expect(state.runs[0].status).toBe(interrupted ? "failed" : "completed");
      const replayResponse = await fetch(`${second.url}/api/chat?runId=${runId}&offset=-1`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(replayResponse.status).toBe(200);
      // A killed SDK log has no terminal chunk: reconnect can deliver its durable
      // prefix but must not be mistaken for a completed stream or awaited to EOF.
      let replay: string;
      if (interrupted) {
        const reader = replayResponse.body!.getReader();
        const decoder = new TextDecoder();
        replay = "";
        while (!replay.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Interrupted log lost its durable prefix");
          replay += decoder.decode(chunk.value, { stream: true });
        }
        await reader.cancel();
        expect(replay).toContain("run.accepted");
        expect(replay).not.toContain("never completed");
      } else {
        replay = await replayResponse.text();
        expect(replay).toBe(completed);
      }
      const firstOffset = /^id: (.+)$/m.exec(replay)?.[1];
      expect(firstOffset).toBeDefined();
      if (!interrupted) {
        const suffix = await fetch(`${second.url}/api/chat?runId=${runId}`, {
          headers: { "Last-Event-ID": firstOffset! },
          signal: AbortSignal.timeout(10_000),
        });
        expect(await suffix.text()).toBe(replay.slice(replay.indexOf("\n\n") + 2));
      }
      if (interrupted) {
        for (const retry of [runId, "new-run-bypass"])
          expect((await post(second, retry)).status).toBe(409);
      }
      expect(readFileSync(join(base, "model-calls"), "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      for (const child of children.reverse()) await stop(child, "SIGKILL");
      rmSync(base, { recursive: true, force: true });
    }
  }, 40_000);
}
