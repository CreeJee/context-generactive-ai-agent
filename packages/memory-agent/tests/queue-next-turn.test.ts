import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MessageQueue } from "../src/queue/queue.ts";
import { testRuntime } from "./support/runtime.ts";

async function setup() {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const queue = await context.runtime.runPromise(MessageQueue);
  const nodes = await context.runtime.runPromise(Nodes);
  const client = new ChatClient({
    threadId: context.session.id,
    persistence: true,
    connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${context.session.id}`, {
      fetchClient: (input, init) =>
        context.runtime.runPromise(
          Effect.flatMap(AgentChat, (chat) =>
            (init?.method ?? "GET") === "POST"
              ? chat.handle(new Request(input, init), context.session.id)
              : chat.hydrate(new Request(input, init), context.session.id),
          ),
        ),
    }),
  });
  client.attach();
  return { context, queue, nodes, client };
}

async function waitForIdle(client: ChatClient) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (!client.getIsLoading()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the chat run");
}

describe("server-selected queued next turn", () => {
  test("refuses an empty queue without recording the placeholder", async () => {
    const { context, nodes, client } = await setup();
    await client.sendMessage("untrusted placeholder", { queuedNext: true });
    expect(client.getError()?.message).toContain("409");
    expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toEqual([]);
    client.dispose();
  });

  test("a hold after a page snapshot blocks delivery before POST", async () => {
    const { context, queue, nodes, client } = await setup();
    const item = queue.add(context.session.id, "previously ready", []);
    expect(queue.snapshot(context.session.id).nextDelivery.kind).toBe("ready");
    await Effect.runPromise(queue.edit(context.session.id, item.id, "unsaved draft"));
    await client.sendMessage("stale client placeholder", { queuedNext: true });
    expect(client.getError()?.message).toContain("409");
    expect(queue.get(context.session.id, item.id)?.state.kind).toBe("editing");
    expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toEqual([]);
    client.dispose();
  });

  test("selects the latest queue head and ignores stale client text", async () => {
    const { context, queue, nodes, client } = await setup();
    const stale = queue.add(context.session.id, "original", []);
    queue.add(context.session.id, "second", []);
    await Effect.runPromise(queue.save(context.session.id, stale.id, "edited on server"));
    await client.sendMessage({ content: [] }, { queuedNext: true });
    await waitForIdle(client);
    expect(client.getError()).toBeUndefined();
    expect(queue.get(context.session.id, stale.id)?.state).toMatchObject({
      kind: "delivered",
      via: "next_turn",
    });
    expect(
      nodes
        .session(context.session.id)
        .filter((node) => node.kind === "user")
        .map((n) => n.text),
    ).toEqual(["edited on server"]);
    expect(
      context.provider!.adapter.invocations[0]?.messages.some(
        (message) => message.role === "user" && message.content === "edited on server",
      ),
    ).toBe(true);
    const chatState = await context.runtime.runPromise(ChatState);
    const stored = await chatState.persistence.stores.messages.loadThread(context.session.id);
    expect(
      stored.some(
        (message) =>
          message.id === stale.id &&
          message.role === "user" &&
          message.content === "edited on server",
      ),
    ).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("original");
    const hydrated = await context.runtime.runPromise(
      Effect.flatMap(AgentChat, (chat) =>
        chat.hydrate(
          new Request(
            `http://127.0.0.1/api/chat?session=${context.session.id}&threadId=${context.session.id}`,
          ),
          context.session.id,
        ),
      ),
    );
    const history = Schema.decodeUnknownSync(
      Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    )(await hydrated.json());
    expect(history.messages.some((message) => message.id === stale.id)).toBe(true);
    client.dispose();
  });
});
