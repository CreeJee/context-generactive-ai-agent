import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MessageQueue } from "../src/queue/queue.ts";
import { sessionHolderHeader } from "../src/sessions/lease-state.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

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
    history: { pageSize: 10_000 },
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
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const agent = await context.runtime.runPromise(AgentChat);
  const run = <A>(effect: Effect.Effect<A>) => context.runtime.runPromise(effect);
  const enqueue = async (text: string, mode: "queue" | "steer", holder: string | null = null) => {
    const response = await run(
      agent.enqueue(context.session.id, holder, { text, attachmentIds: [], mode }),
    );
    return { status: response.status, body: await response.json() };
  };
  const list = async () =>
    Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Queued) }))(
      await (await run(agent.queued(context.session.id))).json(),
    ).items;
  const running = async () => {
    const status = await (await run(agent.status(context.session.id, null))).json();
    return Schema.decodeUnknownSync(
      Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) }),
    )(status).running;
  };
  return { ...context, agent, run, enqueue, list, running };
}

describe("message queue", () => {
  test("claim reserves the head against mutations, then release and delivery clear it", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const first = queue.add(sessionId, "first", []);
    const second = queue.add(sessionId, "second", []);
    expect(queue.claimNext(sessionId)?.id).toBe(first.id);
    expect(queue.claimNext(sessionId)).toBeNull();
    for (const change of [
      queue.edit(sessionId, first.id, "draft"),
      queue.save(sessionId, first.id, "changed"),
      queue.remove(sessionId, first.id),
      queue.confirm(sessionId, first.id),
    ]) {
      expect(await Effect.runPromise(Effect.flip(change))).toMatchObject({ reason: "reserved" });
    }
    expect(queue.get(sessionId, first.id)?.text).toBe("first");
    queue.releaseNext(sessionId, "wrong-id");
    expect(queue.claimNext(sessionId)).toBeNull();
    queue.releaseNext(sessionId, first.id);
    expect(queue.claimNext(sessionId)?.id).toBe(first.id);
    queue.markDelivered(first.id, "next_turn", null, true);
    expect(queue.claimNext(sessionId)?.id).toBe(second.id);
    queue.releaseNext(sessionId, second.id);
    await Effect.runPromise(queue.remove(sessionId, second.id));
  });

  test("claim only decodes the first pending item, respecting barriers and terminal entries", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const terminal = queue.add(sessionId, "already delivered", []);
    queue.markDelivered(terminal.id, "next_turn", null, true);
    const failed = queue.add(sessionId, "already failed", []);
    queue.markFailed(failed.id, "unavailable");
    expect(queue.deliverable(sessionId)).toEqual([]);
    const barrier = queue.add(sessionId, "editing", []);
    const next = queue.add(sessionId, "waiting", []);
    await Effect.runPromise(queue.edit(sessionId, barrier.id, "draft"));
    expect(queue.snapshot(sessionId).nextDelivery).toEqual({
      kind: "blocked",
      messageId: barrier.id,
      reason: "editing",
    });
    expect(queue.claimNext(sessionId)).toBeNull();
    expect(queue.deliverable(sessionId)).toEqual([]);
    await Effect.runPromise(queue.remove(sessionId, barrier.id));
    expect(queue.snapshot(sessionId).nextDelivery).toEqual({ kind: "ready" });
    expect(queue.deliverable(sessionId).map((message) => message.id)).toEqual([next.id]);
    expect(queue.claimNext(sessionId)?.id).toBe(next.id);
    queue.releaseNext(sessionId, next.id);
  });

  test("tool boundary streams only the waiting prefix across terminal rows", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const first = queue.add(sessionId, "first", []);
    const delivered = queue.add(sessionId, "delivered", []);
    queue.markDelivered(delivered.id, "tool_boundary", null, true);
    const failed = queue.add(sessionId, "failed", []);
    queue.markFailed(failed.id, "unavailable");
    const second = queue.add(sessionId, "second", []);
    const barrier = queue.add(sessionId, "held", []);
    const behind = queue.add(sessionId, "behind", []);
    queue.holdWaiting(sessionId);
    await Effect.runPromise(queue.confirm(sessionId, first.id));
    await Effect.runPromise(queue.confirm(sessionId, second.id));
    expect(queue.deliverable(sessionId).map((item) => item.id)).toEqual([first.id, second.id]);
    expect(queue.claimNext(sessionId)?.id).toBe(first.id);
    queue.releaseNext(sessionId, first.id);
    await Effect.runPromise(queue.confirm(sessionId, barrier.id));
    await Effect.runPromise(queue.confirm(sessionId, behind.id));
    expect(queue.deliverable(sessionId).map((item) => item.id)).toEqual([
      first.id,
      second.id,
      barrier.id,
      behind.id,
    ]);
  });

  test("holding during a claim keeps the item held after release", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const item = queue.add(sessionId, "first", []);
    expect(queue.claimNext(sessionId)?.id).toBe(item.id);
    queue.holdWaiting(sessionId);
    expect(queue.get(sessionId, item.id)?.state).toEqual({ kind: "waiting" });
    expect(queue.claimNext(sessionId)).toBeNull();
    queue.releaseNext(sessionId, item.id);
    expect(queue.get(sessionId, item.id)?.state).toEqual({ kind: "held", draft: null });
    expect(queue.claimNext(sessionId)).toBeNull();
    await Effect.runPromise(queue.confirm(sessionId, item.id));
    expect(queue.claimNext(sessionId)?.id).toBe(item.id);
  });

  test("queue endpoint returns the server-owned snapshot contract", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const read = async () =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          items: Schema.Array(Queued),
          nextDelivery: Schema.Union(
            Schema.Struct({ kind: Schema.Literal("ready") }),
            Schema.Struct({
              kind: Schema.Literal("blocked"),
              messageId: Schema.String,
              reason: Schema.Literal("editing", "held"),
            }),
            Schema.Struct({ kind: Schema.Literal("empty") }),
          ),
        }),
      )(await (await context.run(context.agent.queued(sessionId))).json());
    expect(await read()).toMatchObject({ items: [], nextDelivery: { kind: "empty" } });
    const first = queue.add(sessionId, "first", []);
    const second = queue.add(sessionId, "second", []);
    expect(await read()).toMatchObject({
      items: [{ id: first.id }, { id: second.id }],
      nextDelivery: { kind: "ready" },
    });
    await Effect.runPromise(queue.edit(sessionId, first.id, "draft"));
    expect((await read()).nextDelivery).toEqual({
      kind: "blocked",
      messageId: first.id,
      reason: "editing",
    });
  });

  test("server-authoritative turns persist once instead of resending the whole transcript", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);

    await tab.client.sendMessage("first turn");
    await until(() => !tab.client.getIsLoading(), "the first turn to finish");
    await tab.client.sendMessage("second turn");
    await until(() => !tab.client.getIsLoading(), "the second turn to finish");

    const reloaded = openTab(context.runtime, context.session.id);
    await until(() => reloaded.texts("user").length > 0, "the persisted turns");
    expect(reloaded.texts("user")).toEqual(["first turn", "second turn"]);
    tab.client.dispose();
    reloaded.client.dispose();
  }, 15_000);

  test("order holds behind a message being edited, and a restart holds everything for confirmation", async () => {
    const context = await setup();
    const queue = await context.runtime.runPromise(MessageQueue);
    const sessionId = context.session.id;
    const [a, b, c] = ["first", "second", "third"].map((text) => queue.add(sessionId, text, []));
    const ids = () => queue.deliverable(sessionId).map((message) => message.text);

    expect(ids()).toEqual(["first", "second", "third"]);
    expect(queue.snapshot(sessionId).nextDelivery).toEqual({ kind: "ready" });
    await Effect.runPromise(queue.edit(sessionId, b!.id, "second, half typed"));
    // The edited message and everything after it wait; unsaved text is not the message.
    expect(ids()).toEqual(["first"]);
    expect(queue.snapshot(sessionId).nextDelivery).toEqual({ kind: "ready" });
    // A snapshot is advisory: delivery reselects after each edit.
    await Effect.runPromise(queue.edit(sessionId, a!.id, "first draft"));
    expect(queue.snapshot(sessionId).nextDelivery).toEqual({
      kind: "blocked",
      messageId: a!.id,
      reason: "editing",
    });
    expect(queue.deliverable(sessionId)).toEqual([]);
    await Effect.runPromise(queue.save(sessionId, a!.id, "first"));
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
    expect(after.snapshot(sessionId).nextDelivery).toEqual({
      kind: "blocked",
      messageId: b!.id,
      reason: "held",
    });
    expect(after.list(sessionId, null).map((message) => message.state)).toEqual([
      { kind: "held", draft: null },
      { kind: "held", draft: "third, unsaved" },
    ]);
    await Effect.runPromise(after.confirm(sessionId, b!.id));
    expect(after.deliverable(sessionId).map((message) => message.text)).toEqual(["second, edited"]);
    after.markDelivered(b!.id, "next_turn", null, true);
    expect(after.snapshot(sessionId).nextDelivery).toEqual({
      kind: "blocked",
      messageId: c!.id,
      reason: "held",
    });
    await Effect.runPromise(after.remove(sessionId, c!.id));
    expect(after.snapshot(sessionId).nextDelivery).toEqual({ kind: "empty" });
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

    await until(
      () => context.provider!.adapter.invocations.length === 2,
      "the provider continuation",
    );
    await until(() => !tab.client.getIsLoading(), "the run to finish");
    const continuation = context.provider!.adapter.invocations[1];
    expect(
      continuation?.messages.some(
        (message) => message.role === "user" && message.content === "look in the tests folder",
      ),
    ).toBe(true);
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
  }, 10_000);

  test("unavailable steering leaves the message for an explicit queue fallback", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => context.provider!.adapter.invocations.length === 1, "the run to start");

    const steered = await context.enqueue("shorter please", "steer");
    expect(steered.status).toBe(409);
    expect(steered.body).toEqual({ error: "steer_unavailable" });
    expect(await context.list()).toEqual([]);

    const queued = await context.enqueue("shorter please", "queue");
    expect(queued.status).toBe(201);
    expect(decodeQueued(queued.body).state).toEqual({ kind: "waiting" });

    await until(() => tab.answer().includes("done"), "the answer to finish");
    await until(() => !tab.client.getIsLoading(), "the run to finish");
    const [held] = await context.list();
    expect(held?.text).toBe("shorter please");
    expect(held?.state).toEqual({ kind: "held", draft: null });
    tab.client.dispose();

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
    await until(() => context.provider!.adapter.invocations.length === 1, "the answer to start");
    const first = decodeQueued((await context.enqueue("hello again", "queue", "tab")).body);
    const second = decodeQueued((await context.enqueue("and once more", "queue", "tab")).body);
    await until(() => tab.answer().includes("done"), "the first answer");
    await until(() => !tab.client.getIsLoading(), "the run to finish");
    // No tool call happened, so both are still waiting for the page.
    expect((await context.list()).map((message) => message.state.kind)).toEqual([
      "waiting",
      "waiting",
    ]);

    // Supplying an ID is no longer a valid request; the server alone picks the head.
    await tab.client.sendMessage("and once more", { queuedMessageId: second.id });
    expect(tab.client.getError()?.message).toContain("400");

    // A snapshot captured `first`, but the server must select the current head after an edit.
    const edited = await context.run(
      context.agent.editQueued(context.session.id, "tab", first.id, {
        action: "save",
        text: "hello, freshly edited",
      }),
    );
    expect(edited.status).toBe(200);
    await tab.client.sendMessage("stale client placeholder", { queuedNext: true });
    await until(() => tab.answer().includes("Hello from fast-1"), "the next turn");
    await until(() => !tab.client.getIsLoading(), "the next turn to finish");
    const states = (await context.list()).map((message) => [message.text, message.state.kind]);
    expect(states).toEqual([
      ["hello, freshly edited", "delivered"],
      ["and once more", "waiting"],
    ]);
    const nodes = await context.runtime.runPromise(Nodes);
    expect(
      nodes
        .session(context.session.id)
        .filter((node) => node.kind === "user")
        .map((n) => n.text),
    ).toEqual(["please be slow", "hello, freshly edited"]);
    expect(
      context.provider!.adapter.invocations[1]?.messages.some(
        (message) => message.role === "user" && message.content === "hello, freshly edited",
      ),
    ).toBe(true);
    tab.client.dispose();
  });

  test("queuedNext refuses an empty queue without persisting the placeholder", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    await tab.client.sendMessage("placeholder", { queuedNext: true });
    expect(tab.client.getError()?.message).toContain("409");
    const nodes = await context.runtime.runPromise(Nodes);
    expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toEqual([]);
    tab.client.dispose();
  });

  test("a cancel holds what was waiting until the user confirms it", async () => {
    const context = await setup();
    const tab = openTab(context.runtime, context.session.id);
    void tab.client.sendMessage("please be slow");
    await until(() => context.provider!.adapter.invocations.length === 1, "the answer to start");
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
