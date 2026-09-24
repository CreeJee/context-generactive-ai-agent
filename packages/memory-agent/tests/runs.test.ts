import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

type Runtime = Awaited<ReturnType<typeof testRuntime>>["runtime"];

const Status = Schema.Struct({
  actions: Schema.Struct({
    phases: Schema.Record(
      Schema.String,
      Schema.Struct({ allowed: Schema.Boolean, reason: Schema.optional(Schema.String) }),
    ),
    controls: Schema.Record(
      Schema.String,
      Schema.Struct({ allowed: Schema.Boolean, reason: Schema.optional(Schema.String) }),
    ),
  }),
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
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  return context;
}

const statusOf = async (runtime: Runtime, sessionId: string) => {
  const response = await runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) => agent.status(sessionId, null)),
  );
  return Schema.decodeUnknownSync(Status)(await response.json());
};

describe("runs across reloads, cancels and restarts", () => {
  test("a reloaded page rejoins a durable app run without invoking the provider again", async () => {
    const { runtime, session, provider } = await setup();
    const first = openTab(runtime, session.id);
    void first.client.sendMessage("please be slow");
    await until(() => provider!.adapter.invocations.length === 1, "the provider run to start");
    // The tab reloads mid-answer.
    first.client.dispose();

    const second = openTab(runtime, session.id);
    await until(() => second.text().endsWith("done"), "the rest of the answer");
    expect(second.text()).toBe("done");
    await until(() => !second.client.getSessionGenerating(), "the rejoined run to settle");
    second.client.dispose();

    expect(provider!.adapter.invocations).toHaveLength(1);
    expect((await statusOf(runtime, session.id)).lastRun?.status).toBe("completed");
  });

  test("cancel stops the running run and reports that it really stopped", async () => {
    const { runtime, session, provider } = await setup();
    const tab = openTab(runtime, session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => provider!.adapter.invocations.length === 1, "the provider run to start");
    const running = await statusOf(runtime, session.id);
    expect(running.running).not.toBeNull();
    for (const decision of Object.values(running.actions.phases))
      expect(decision).toEqual({ allowed: false, reason: "run_in_progress" });
    expect(running.actions.controls.resume).toEqual({ allowed: false, reason: "run_in_progress" });
    const refused = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.setWorkflowPhase(session.id, null, "plan")),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "run_in_progress" });

    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
    );
    const cancelled = Schema.decodeUnknownSync(Cancelled)(await response.json());
    expect(cancelled).toMatchObject({ stopped: true, status: "aborted" });
    expect(provider!.adapter.invocations).toHaveLength(1);
    expect(tab.text()).not.toContain("done");

    const status = await statusOf(runtime, session.id);
    expect(status.running).toBeNull();
    expect(status.lastRun?.status).toBe("aborted");

    // Nothing is running any more, so a second cancel has nothing to stop.
    const again = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
    );
    expect(again.status).toBe(409);
    const seen = tab.text();
    tab.client.dispose();

    // A reload shows exactly the durable text saved before cancellation and does not rerun it.
    const reloaded = openTab(runtime, session.id);
    await until(() => reloaded.client.getMessages().length > 0, "the stored transcript");
    expect(reloaded.text()).toBe(seen);
    expect(provider!.adapter.invocations).toHaveLength(1);
    reloaded.client.dispose();
  });

  test("a second run in the same session is refused while the first is answering", async () => {
    const { runtime, session, provider } = await setup();
    const tab = openTab(runtime, session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => provider!.adapter.invocations.length === 1, "the first run to start");

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
    await runtime.runPromise(Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)));
    tab.client.dispose();
  });

  test("after a restart an unfinished run is marked failed, not resumed or rerun", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please be slow");
    await until(
      () => context.provider!.adapter.invocations.length === 1,
      "the run to be answering",
    );
    tab.client.dispose();

    const restarted = await context.reopen();
    const status = await statusOf(restarted, context.session.id);
    expect(status.running).toBeNull();
    expect(status.lastRun).toMatchObject({
      status: "failed",
      error: { code: "server_restarted" },
    });
    // No run is offered for rejoining, and the provider was not asked to start anything again.
    const reloaded = openTab(restarted, context.session.id);
    await until(() => reloaded.client.getMessages().length > 0, "the stored transcript");
    expect(reloaded.client.getSessionGenerating()).toBe(false);
    expect(context.provider!.adapter.invocations).toHaveLength(1);
    reloaded.client.dispose();
  });

  test("a restart retires an approval whose app-run continuation no longer exists", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    // Approval deliberately pauses the request, so wait for the interrupt rather than for the
    // send promise, which only settles after that interrupt has been answered.
    void tab.client.sendMessage("please use the shell");
    await until(() => tab.client.getInterrupts().length === 1, "the approval request");
    tab.client.dispose();

    const restarted = await context.reopen();
    const reloaded = openTab(restarted, context.session.id);
    await until(() => reloaded.client.getMessages().length > 0, "the restored transcript");
    expect(reloaded.client.getInterrupts()).toEqual([]);
    expect(reloaded.client.getError()).toBeUndefined();
    expect(await statusOf(restarted, context.session.id)).toMatchObject({
      running: null,
      lastRun: { status: "failed", error: { code: "server_restarted" } },
    });
    reloaded.client.dispose();
  });
});
