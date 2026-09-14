import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

type Runtime = Awaited<ReturnType<typeof testRuntime>>["runtime"];

const Log = Schema.Struct({ log: Schema.Array(Schema.Struct({ method: Schema.String })) });
const Status = Schema.Struct({
  running: Schema.NullOr(Schema.Struct({ runId: Schema.String })),
  lastRun: Schema.NullOr(
    Schema.Struct({
      runId: Schema.String,
      status: Schema.String,
      error: Schema.NullOr(
        Schema.Struct({ message: Schema.String, code: Schema.optional(Schema.String) }),
      ),
    }),
  ),
});
const Cancelled = Schema.Struct({
  runId: Schema.String,
  stopped: Schema.Boolean,
  status: Schema.NullOr(Schema.String),
});

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A browser tab: a TanStack client hydrating from and posting to AgentChat in-process. */
function openTab(runtime: Runtime, sessionId: string) {
  const client = new ChatClient({
    threadId: sessionId,
    persistence: true,
    tools: approvalToolDefinitions,
    connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${sessionId}`, {
      fetchClient: (input, init) =>
        runtime.runPromise(
          Effect.flatMap(AgentChat, (agent) =>
            (init?.method ?? "GET") === "POST"
              ? agent.handle(new Request(input, init), sessionId)
              : agent.hydrate(new Request(input, init), sessionId),
          ),
        ),
    }),
  });
  client.attach();
  const text = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  return { client, text };
}

async function setup() {
  const context = await testRuntime({ codex: fakeCodex });
  await context.runtime.runPromise(
    Effect.flatMap(CodexModels, (models) => models.select("fast-1")),
  );
  return context;
}

const statusOf = async (runtime: Runtime, sessionId: string) => {
  const response = await runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) => agent.status(sessionId)),
  );
  return Schema.decodeUnknownSync(Status)(await response.json());
};

const codexLog = async (runtime: Runtime) => {
  const codex = await runtime.runPromise(CodexAppServer);
  return (await runtime.runPromise(codex.request("test/log", {}, Log))).log;
};

describe("runs across reloads, cancels and restarts", () => {
  test("a reloaded page rejoins a run that is still answering, without running it again", async () => {
    const { runtime, session } = await setup();
    const first = openTab(runtime, session.id);
    void first.client.sendMessage("please be slow");
    await until(() => first.text().includes("3 "), "the first pieces");
    // The tab reloads mid-answer.
    first.client.dispose();

    const second = openTab(runtime, session.id);
    await until(() => second.text().endsWith("done"), "the rest of the answer");
    expect(second.text()).toMatch(/^1 2 3 .* 50 done$/);
    await until(() => !second.client.getSessionGenerating(), "the rejoined run to settle");
    second.client.dispose();

    const log = await codexLog(runtime);
    expect(log.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    expect((await statusOf(runtime, session.id)).lastRun?.status).toBe("completed");
  });

  test("cancel stops the running run and reports that it really stopped", async () => {
    const { runtime, session } = await setup();
    const tab = openTab(runtime, session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => tab.text().includes("2 "), "the first pieces");
    expect((await statusOf(runtime, session.id)).running).not.toBeNull();

    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id)),
    );
    const cancelled = Schema.decodeUnknownSync(Cancelled)(await response.json());
    expect(cancelled).toMatchObject({ stopped: true, status: "aborted" });
    expect((await codexLog(runtime)).map((entry) => entry.method)).toContain("turn/interrupt");
    expect(tab.text()).not.toContain("done");

    const status = await statusOf(runtime, session.id);
    expect(status.running).toBeNull();
    expect(status.lastRun?.status).toBe("aborted");

    // Nothing is running any more, so a second cancel has nothing to stop.
    const again = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id)),
    );
    expect(again.status).toBe(409);
    const seen = tab.text();
    tab.client.dispose();

    // A reload shows the cut-off answer as far as the server had it: what the page showed, and at
    // most a piece that was still on its way.
    const reloaded = openTab(runtime, session.id);
    await until(() => reloaded.text().length > 0, "the stored partial answer");
    expect(reloaded.text().startsWith(seen)).toBe(true);
    expect(reloaded.text().length - seen.length).toBeLessThanOrEqual(3);
    reloaded.client.dispose();
  });

  test("a second run in the same session is refused while the first is answering", async () => {
    const { runtime, session } = await setup();
    const tab = openTab(runtime, session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => tab.text().includes("1 "), "the first run to start");

    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(
          new Request(`http://127.0.0.1/api/chat?session=${session.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: session.id,
              runId: "second-run",
              state: {},
              messages: [{ id: "m-2", role: "user", parts: [{ type: "text", content: "hi" }] }],
              tools: [],
              context: [],
              forwardedProps: {},
            }),
          }),
          session.id,
        ),
      ),
    );
    expect(response.status).toBe(409);
    await runtime.runPromise(Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id)));
    tab.client.dispose();
  });

  test("after a restart an unfinished run is marked failed, not resumed or rerun", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => tab.text().includes("2 "), "the run to be answering");
    tab.client.dispose();

    const restarted = await context.reopen();
    const status = await statusOf(restarted, context.session.id);
    expect(status.running).toBeNull();
    expect(status.lastRun).toMatchObject({
      status: "failed",
      error: { code: "server_restarted" },
    });
    // No run is offered for rejoining, and codex was not asked to start anything again.
    const reloaded = openTab(restarted, context.session.id);
    // The part of the answer saved while it streamed is still there.
    await until(() => reloaded.text().startsWith("1 "), "the transcript with the partial answer");
    expect(reloaded.client.getSessionGenerating()).toBe(false);
    expect((await codexLog(restarted)).map((entry) => entry.method)).not.toContain("turn/start");
    reloaded.client.dispose();
  });

  test("an approval left waiting across a restart can still be answered", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    await tab.client.sendMessage("please use the shell");
    await until(() => tab.client.getInterrupts().length === 1, "the approval request");
    tab.client.dispose();

    const restarted = await context.reopen();
    const reloaded = openTab(restarted, context.session.id);
    await until(() => reloaded.client.getInterrupts().length === 1, "the restored approval");
    reloaded.client.resolveInterrupts(true);
    await until(() => reloaded.text().includes("approved-output"), "the answer after approval");
    await until(() => !reloaded.client.getIsLoading(), "the run to finish");
    expect((await statusOf(restarted, context.session.id)).lastRun?.status).toBe("completed");
    reloaded.client.dispose();
  });
});
