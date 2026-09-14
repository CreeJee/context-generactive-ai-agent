import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MessageQueue } from "../src/queue/queue.ts";
import { sessionHolderHeader } from "../src/sessions/lease-state.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

type Runtime = Awaited<ReturnType<typeof testRuntime>>["runtime"];

const Queued = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  state: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("waiting") }),
    Schema.Struct({ kind: Schema.Literal("editing"), draft: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("held"), draft: Schema.NullOr(Schema.String) }),
    Schema.Struct({
      kind: Schema.Literal("delivered"),
      via: Schema.Literal("tool_boundary", "steer", "next_turn"),
      runId: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
  ),
});
const decodeQueued = Schema.decodeUnknownSync(Queued);
const decodeList = Schema.decodeUnknownSync(Schema.Array(Queued));

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function openTab(runtime: Runtime, sessionId: string, holder: string | null = null) {
  const client = new ChatClient({
    threadId: sessionId,
    persistence: true,
    tools: approvalToolDefinitions,
    connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${sessionId}`, {
      headers: holder ? { [sessionHolderHeader]: holder } : {},
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
  const texts = (role: "user" | "assistant") =>
    client
      .getMessages()
      .filter((message) => message.role === role)
      .map((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join(""),
      );
  return { client, texts, answer: () => texts("assistant").join("") };
}

async function setup() {
  const context = await testRuntime({ codex: fakeCodex });
  await context.runtime.runPromise(
    Effect.flatMap(CodexModels, (models) => models.select("fast-1")),
  );
  const agent = await context.runtime.runPromise(AgentChat);
  const run = <A>(effect: Effect.Effect<A>) => context.runtime.runPromise(effect);
  const enqueue = async (text: string, mode: "queue" | "steer", holder: string | null = null) => {
    const response = await run(
      agent.enqueue(context.session.id, holder, { text, attachmentIds: [], mode }),
    );
    return { status: response.status, body: await response.json() };
  };
  const list = async () => decodeList(await (await run(agent.queued(context.session.id))).json());
  const running = async () => {
    const status = await (await run(agent.status(context.session.id, null))).json();
    return Schema.decodeUnknownSync(
      Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) }),
    )(status).running;
  };
  return { ...context, agent, run, enqueue, list, running };
}

describe("message queue", () => {
  test("order holds behind a message being edited, and a restart holds everything for confirmation", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const [a, b, c] = ["first", "second", "third"].map((text) => queue.add(sessionId, text, []));
    const ids = () => queue.deliverable(sessionId).map((message) => message.text);

    expect(ids()).toEqual(["first", "second", "third"]);
    await Effect.runPromise(queue.edit(sessionId, b!.id, "second, half typed"));
    // The edited message and everything after it wait; unsaved text is not the message.
    expect(ids()).toEqual(["first"]);
    expect(queue.get(sessionId, b!.id)).toMatchObject({
      text: "second",
      state: { kind: "editing", draft: "second, half typed" },
    });
    await Effect.runPromise(queue.save(sessionId, b!.id, "second, edited"));
    expect(ids()).toEqual(["first", "second, edited", "third"]);

    await Effect.runPromise(queue.remove(sessionId, a!.id));
    await Effect.runPromise(queue.edit(sessionId, c!.id, "third, unsaved"));
    const restarted = await context.reopen();
    const after = await restarted.runPromise(MessageQueue);
    // Nothing goes out on its own after a restart; the unsaved edit is kept as a draft.
    expect(after.deliverable(sessionId)).toEqual([]);
    expect(after.list(sessionId, null).map((message) => message.state)).toEqual([
      { kind: "held", draft: null },
      { kind: "held", draft: "third, unsaved" },
    ]);
    await Effect.runPromise(after.confirm(sessionId, b!.id));
    expect(after.deliverable(sessionId).map((message) => message.text)).toEqual(["second, edited"]);
  });

  test("a queued message reaches the agent when the next tool call returns", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please check files");
    await until(() => tab.client.getIsLoading(), "the run to start");
    for (let attempt = 0; attempt < 50 && !(await context.running()); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));

    const queued = await context.enqueue("look in the tests folder", "queue");
    expect(queued.status).toBe(201);
    expect(decodeQueued(queued.body).state).toEqual({ kind: "waiting" });

    await until(() => tab.answer().includes("Heard:"), "the answer");
    await until(() => !tab.client.getIsLoading(), "the run to finish");
    expect(tab.answer()).toContain("Heard: look in the tests folder");
    const [delivered] = await context.list();
    expect(delivered?.state).toMatchObject({ kind: "delivered", via: "tool_boundary" });

    const nodes = await context.runtime.runPromise(Nodes);
    expect(
      nodes
        .session(context.session.id)
        .filter((node) => node.kind === "user")
        .map((n) => n.text),
    ).toEqual(["please check files", "look in the tests folder"]);
    tab.client.dispose();

    // The saved conversation has it too, so the next send does not drop it.
    const reloaded = openTab(context.runtime, context.session.id);
    await until(() => reloaded.texts("user").length === 2, "the saved conversation");
    expect(reloaded.texts("user")).toEqual(["please check files", "look in the tests folder"]);
    reloaded.client.dispose();
  });

  test("steering sends a message into the answering turn at once", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => tab.answer().includes("2 "), "the answer to start");

    const steered = await context.enqueue("shorter please", "steer");
    expect(steered.status).toBe(201);
    expect(decodeQueued(steered.body).state).toMatchObject({ kind: "delivered", via: "steer" });

    await until(() => tab.answer().includes("done"), "the answer to finish");
    await until(() => !tab.client.getIsLoading(), "the run to finish");
    // The reply to the steered message is a new paragraph, not glued onto the last sentence.
    expect(tab.answer()).toContain("done\n\nsteered: shorter please");
    tab.client.dispose();

    const reloaded = openTab(context.runtime, context.session.id);
    await until(() => reloaded.texts("user").length === 2, "the saved conversation");
    expect(reloaded.client.getMessages().map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    reloaded.client.dispose();

    // With nothing answering there is nothing to queue for or steer into.
    expect((await context.enqueue("too late", "steer")).status).toBe(409);
    expect((await context.enqueue("too late", "queue")).status).toBe(409);
  });

  test("after a normal finish the page sends the next queued message as a turn", async () => {
    const context = await setup();
    // The page holds the session, so waiting messages are left for it to send.
    await context.run(context.agent.lease(context.session.id, "tab", "claim"));
    const tab = openTab(context.runtime, context.session.id, "tab");
    void tab.client.sendMessage("please be slow");
    await until(() => tab.answer().includes("1 "), "the answer to start");
    const first = decodeQueued((await context.enqueue("hello again", "queue", "tab")).body);
    const second = decodeQueued((await context.enqueue("and once more", "queue", "tab")).body);
    await until(() => tab.answer().includes("done"), "the first answer");
    await until(() => !tab.client.getIsLoading(), "the run to finish");
    // No tool call happened, so both are still waiting for the page.
    expect((await context.list()).map((message) => message.state.kind)).toEqual([
      "waiting",
      "waiting",
    ]);

    // Only the first in line may go.
    await tab.client.sendMessage("and once more", { queuedMessageId: second.id });
    expect(tab.client.getError()?.message).toContain("409");

    await tab.client.sendMessage("hello again", { queuedMessageId: first.id });
    await until(() => tab.answer().includes("Hello from fast-1"), "the next turn");
    await until(() => !tab.client.getIsLoading(), "the next turn to finish");
    const states = (await context.list()).map((message) => [message.text, message.state.kind]);
    expect(states).toEqual([
      ["hello again", "delivered"],
      ["and once more", "waiting"],
    ]);
    tab.client.dispose();
  });

  test("a cancel holds what was waiting until the user confirms it", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => tab.answer().includes("1 "), "the answer to start");
    await context.enqueue("never mind", "queue");
    await context.run(context.agent.cancel(context.session.id, null));
    await until(() => !tab.client.getIsLoading(), "the run to stop");
    tab.client.stop();

    const [held] = await context.list();
    expect(held?.state).toEqual({ kind: "held", draft: null });
    const confirmed = await context.run(
      context.agent.editQueued(context.session.id, null, held!.id, { action: "confirm" }),
    );
    expect(decodeQueued(await confirmed.json()).state).toEqual({ kind: "waiting" });
    tab.client.dispose();
  });
});
