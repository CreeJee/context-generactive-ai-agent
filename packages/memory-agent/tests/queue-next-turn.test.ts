import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { waitUntil } from "./support/wait-until.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MessageQueue } from "../src/queue/queue.ts";
import { testRuntime } from "./support/runtime.ts";

const setup = Effect.fnUntraced(function* () {
  const context = yield* Effect.tryPromise({
    try: () => testRuntime({ testProvider: {} }),
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
  const queue = yield* Effect.provideContext(MessageQueue, yield* context.runtime.contextEffect);
  const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new ChatClient({
          threadId: context.session.id,
          persistence: true,
          connection: fetchServerSentEvents(
            `http://127.0.0.1/api/chat?session=${context.session.id}`,
            {
              fetchClient: (input, init) =>
                context.runtime.runPromise(
                  Effect.flatMap(AgentChat, (chat) =>
                    (init?.method ?? "GET") === "POST"
                      ? chat.handle(new Request(input, init), context.session.id)
                      : chat.hydrate(new Request(input, init), context.session.id),
                  ),
                ),
            },
          ),
        }),
    ),
    (client) => Effect.sync(() => client.dispose()),
  );
  client.attach();
  return { context, queue, nodes, client };
});

const waitForIdle = (client: ChatClient) =>
  waitUntil(() => !client.getIsLoading(), "the run to finish", 6_000);

describe("server-selected queued next turn", () => {
  it.live("refuses an empty queue without recording the placeholder", () =>
    Effect.gen(function* () {
      const { context, nodes, client } = yield* setup();
      yield* Effect.tryPromise({
        try: () => client.sendMessage("untrusted placeholder", { queuedNext: true }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(client.getError()?.message).toContain("409");
      expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toEqual([]);
      client.dispose();
    }),
  );

  it.live("a hold after a page snapshot blocks delivery before POST", () =>
    Effect.gen(function* () {
      const { context, queue, nodes, client } = yield* setup();
      const item = queue.add(context.session.id, "previously ready", []);
      expect(queue.snapshot(context.session.id).nextDelivery.kind).toBe("ready");
      yield* queue.edit(context.session.id, item.id, "unsaved draft");
      yield* Effect.tryPromise({
        try: () => client.sendMessage("stale client placeholder", { queuedNext: true }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(client.getError()?.message).toContain("409");
      expect(queue.get(context.session.id, item.id)?.state.kind).toBe("editing");
      expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toEqual([]);
      client.dispose();
    }),
  );

  it.live("selects the latest queue head and ignores stale client text", () =>
    Effect.gen(function* () {
      const { context, queue, nodes, client } = yield* setup();
      const stale = queue.add(context.session.id, "original", []);
      queue.add(context.session.id, "second", []);
      yield* queue.save(context.session.id, stale.id, "edited on server");
      yield* Effect.tryPromise({
        try: () => client.sendMessage({ content: [] }, { queuedNext: true }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* waitForIdle(client);
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
      const chatState = yield* Effect.provideContext(
        ChatState,
        yield* context.runtime.contextEffect,
      );
      const stored = yield* Effect.tryPromise({
        try: () => chatState.persistence.stores.messages.loadThread(context.session.id),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(
        stored.some(
          (message) =>
            message.id === stale.id &&
            message.role === "user" &&
            message.content === "edited on server",
        ),
      ).toBe(true);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(stored),
      ).not.toContain("original");
      const hydrated = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (chat) =>
          chat.hydrate(
            new Request(
              `http://127.0.0.1/api/chat?session=${context.session.id}&threadId=${context.session.id}`,
            ),
            context.session.id,
          ),
        ),
        yield* context.runtime.contextEffect,
      );
      const history = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      )(
        yield* Effect.tryPromise({
          try: () => hydrated.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      );
      expect(history.messages.some((message) => message.id === stale.id)).toBe(true);
      client.dispose();
    }),
  );
});
