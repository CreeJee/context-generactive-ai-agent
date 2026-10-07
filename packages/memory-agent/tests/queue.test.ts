import { isTruthy } from "../src/truthy.ts";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Option, Schedule, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { waitUntil } from "./support/wait-until.ts";
import { selectTestModel } from "./support/provider.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MessageQueue } from "../src/queue/queue.ts";
import { sessionHolderHeader } from "../src/sessions/lease-state.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { turnGate } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

type Runtime = Awaited<ReturnType<typeof testRuntime>>["runtime"];

const Queued = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("waiting") }),
    Schema.Struct({ kind: Schema.Literal("editing"), draft: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("held"), draft: Schema.NullOr(Schema.String) }),
    Schema.Struct({
      kind: Schema.Literal("delivered"),
      via: Schema.Literals(["tool_boundary", "steer", "next_turn"]),
      runId: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
  ]),
});
const decodeQueued = Schema.decodeUnknownEffect(Queued);

const until = (condition: () => boolean, what: string) => waitUntil(condition, what, 6_000);

const openTab = Effect.fnUntraced(function* (
  runtime: Runtime,
  sessionId: string,
  holder: string | null = null,
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new ChatClient({
          threadId: sessionId,
          persistence: true,
          history: { pageSize: 10_000 },
          tools: approvalToolDefinitions,
          connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${sessionId}`, {
            headers: isTruthy(holder) ? { [sessionHolderHeader]: holder } : {},
            fetchClient: (input, init) =>
              runtime.runPromise(
                Effect.flatMap(AgentChat, (agent) =>
                  (init?.method ?? "GET") === "POST"
                    ? agent.handle(new Request(input, init), sessionId)
                    : agent.hydrate(new Request(input, init), sessionId),
                ),
              ),
          }),
        }),
    ),
    (client) => Effect.sync(() => client.dispose()),
  );
  client.attach();
  const texts = (role: "user" | "assistant") =>
    client
      .getMessages()
      .filter((message) => message.role === role)
      .map((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join(""),
      );
  return { client, texts, answer: () => texts("assistant").join("") };
});

const setup = Effect.fnUntraced(function* (gateDelayedTurns: boolean = true) {
  const gate = turnGate();
  const context = yield* call(() =>
    testRuntime({
      testProvider: gateDelayedTurns ? { delayedTurnGate: gate.waitFor } : {},
    }),
  );
  yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
  const agent = yield* Effect.provideContext(AgentChat, yield* context.runtime.contextEffect);

  const enqueue = Effect.fnUntraced(function* (
    text: string,
    mode: "queue" | "steer",
    holder: string | null = null,
  ) {
    const response = yield* agent.enqueue(context.session.id, holder, {
      text,
      attachmentIds: [],
      mode,
    });
    return { status: response.status, body: yield* call(() => response.json()) };
  });
  const list = Effect.fnUntraced(function* () {
    return (yield* Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Array(Queued) }))(
      yield* Effect.flatMap(agent.queued(context.session.id), (response) =>
        call(() => response.json()),
      ),
    )).items;
  });
  const running = Effect.fnUntraced(function* () {
    const status = yield* Effect.flatMap(agent.status(context.session.id, null), (response) =>
      call(() => response.json()),
    );
    return (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) }),
    )(status)).running;
  });
  return { ...context, agent, enqueue, list, running, releaseDelayedTurn: gate.release };
});

describe("message queue", () => {
  it.live("claim reserves the head against mutations, then release and delivery clear it", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const queue = yield* Effect.provideContext(
        MessageQueue,
        yield* context.runtime.contextEffect,
      );
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
        expect(yield* Effect.flip(change)).toMatchObject({ reason: "reserved" });
      }
      expect(queue.get(sessionId, first.id)?.text).toBe("first");
      queue.releaseNext(sessionId, "wrong-id");
      expect(queue.claimNext(sessionId)).toBeNull();
      queue.releaseNext(sessionId, first.id);
      expect(queue.claimNext(sessionId)?.id).toBe(first.id);
      queue.markDelivered(first.id, "next_turn", null, true);
      expect(queue.claimNext(sessionId)?.id).toBe(second.id);
      queue.releaseNext(sessionId, second.id);
      yield* queue.remove(sessionId, second.id);
    }),
  );

  it.live(
    "claim only decodes the first pending item, respecting barriers and terminal entries",
    () =>
      Effect.gen(function* () {
        const context = yield* setup();
        const queue = yield* Effect.provideContext(
          MessageQueue,
          yield* context.runtime.contextEffect,
        );
        const sessionId = context.session.id;
        const terminal = queue.add(sessionId, "already delivered", []);
        queue.markDelivered(terminal.id, "next_turn", null, true);
        const failed = queue.add(sessionId, "already failed", []);
        queue.markFailed(failed.id, "unavailable");
        expect(queue.deliverable(sessionId)).toEqual([]);
        const barrier = queue.add(sessionId, "editing", []);
        const next = queue.add(sessionId, "waiting", []);
        yield* queue.edit(sessionId, barrier.id, "draft");
        expect(queue.snapshot(sessionId).nextDelivery).toEqual({
          kind: "blocked",
          messageId: barrier.id,
          reason: "editing",
        });
        expect(queue.claimNext(sessionId)).toBeNull();
        expect(queue.deliverable(sessionId)).toEqual([]);
        yield* queue.remove(sessionId, barrier.id);
        expect(queue.snapshot(sessionId).nextDelivery).toEqual({ kind: "ready" });
        expect(queue.deliverable(sessionId).map((message) => message.id)).toEqual([next.id]);
        expect(queue.claimNext(sessionId)?.id).toBe(next.id);
        queue.releaseNext(sessionId, next.id);
      }),
  );

  it.live("tool boundary streams only the waiting prefix across terminal rows", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const queue = yield* Effect.provideContext(
        MessageQueue,
        yield* context.runtime.contextEffect,
      );
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
      yield* queue.confirm(sessionId, first.id);
      yield* queue.confirm(sessionId, second.id);
      expect(queue.deliverable(sessionId).map((item) => item.id)).toEqual([first.id, second.id]);
      expect(queue.claimNext(sessionId)?.id).toBe(first.id);
      queue.releaseNext(sessionId, first.id);
      yield* queue.confirm(sessionId, barrier.id);
      yield* queue.confirm(sessionId, behind.id);
      expect(queue.deliverable(sessionId).map((item) => item.id)).toEqual([
        first.id,
        second.id,
        barrier.id,
        behind.id,
      ]);
    }),
  );

  it.live("holding during a claim keeps the item held after release", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const queue = yield* Effect.provideContext(
        MessageQueue,
        yield* context.runtime.contextEffect,
      );
      const sessionId = context.session.id;
      const item = queue.add(sessionId, "first", []);
      expect(queue.claimNext(sessionId)?.id).toBe(item.id);
      queue.holdWaiting(sessionId);
      expect(queue.get(sessionId, item.id)?.state).toEqual({ kind: "waiting" });
      expect(queue.claimNext(sessionId)).toBeNull();
      queue.releaseNext(sessionId, item.id);
      expect(queue.get(sessionId, item.id)?.state).toEqual({ kind: "held", draft: null });
      expect(queue.claimNext(sessionId)).toBeNull();
      yield* queue.confirm(sessionId, item.id);
      expect(queue.claimNext(sessionId)?.id).toBe(item.id);
    }),
  );

  it.live("queue endpoint returns the server-owned snapshot contract", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const queue = yield* Effect.provideContext(
        MessageQueue,
        yield* context.runtime.contextEffect,
      );
      const sessionId = context.session.id;
      const read = Effect.fnUntraced(function* () {
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Queued),
            nextDelivery: Schema.Union([
              Schema.Struct({ kind: Schema.Literal("ready") }),
              Schema.Struct({
                kind: Schema.Literal("blocked"),
                messageId: Schema.String,
                reason: Schema.Literals(["editing", "held"]),
              }),
              Schema.Struct({ kind: Schema.Literal("empty") }),
            ]),
          }),
        )(
          yield* Effect.flatMap(context.agent.queued(sessionId), (response) =>
            call(() => response.json()),
          ),
        );
      });
      expect(yield* read()).toMatchObject({ items: [], nextDelivery: { kind: "empty" } });
      const first = queue.add(sessionId, "first", []);
      const second = queue.add(sessionId, "second", []);
      expect(yield* read()).toMatchObject({
        items: [{ id: first.id }, { id: second.id }],
        nextDelivery: { kind: "ready" },
      });
      yield* queue.edit(sessionId, first.id, "draft");
      expect((yield* read()).nextDelivery).toEqual({
        kind: "blocked",
        messageId: first.id,
        reason: "editing",
      });
    }),
  );

  it.live(
    "server-authoritative turns persist once instead of resending the whole transcript",
    () =>
      Effect.gen(function* () {
        const context = yield* setup();
        const tab = yield* openTab(context.runtime, context.session.id);

        yield* call(() => tab.client.sendMessage("first turn"));
        yield* until(() => !tab.client.getIsLoading(), "the first turn to finish");
        yield* call(() => tab.client.sendMessage("second turn"));
        yield* until(() => !tab.client.getIsLoading(), "the second turn to finish");

        const reloaded = yield* openTab(context.runtime, context.session.id);
        yield* until(() => reloaded.texts("user").length > 0, "the persisted turns");
        expect(reloaded.texts("user")).toEqual(["first turn", "second turn"]);
        tab.client.dispose();
        reloaded.client.dispose();
      }),
    15_000,
  );

  it.live(
    "order holds behind a message being edited, and a restart holds everything for confirmation",
    () =>
      Effect.gen(function* () {
        const context = yield* setup();
        const queue = yield* Effect.provideContext(
          MessageQueue,
          yield* context.runtime.contextEffect,
        );
        const sessionId = context.session.id;
        const [a, b, c] = ["first", "second", "third"].map((text) =>
          queue.add(sessionId, text, []),
        );
        const ids = () => queue.deliverable(sessionId).map((message) => message.text);

        expect(ids()).toEqual(["first", "second", "third"]);
        expect(queue.snapshot(sessionId).nextDelivery).toEqual({ kind: "ready" });
        yield* queue.edit(sessionId, b!.id, "second, half typed");
        // The edited message and everything after it wait; unsaved text is not the message.
        expect(ids()).toEqual(["first"]);
        expect(queue.snapshot(sessionId).nextDelivery).toEqual({ kind: "ready" });
        // A snapshot is advisory: delivery reselects after each edit.
        yield* queue.edit(sessionId, a!.id, "first draft");
        expect(queue.snapshot(sessionId).nextDelivery).toEqual({
          kind: "blocked",
          messageId: a!.id,
          reason: "editing",
        });
        expect(queue.deliverable(sessionId)).toEqual([]);
        yield* queue.save(sessionId, a!.id, "first");
        expect(queue.get(sessionId, b!.id)).toMatchObject({
          text: "second",
          state: { kind: "editing", draft: "second, half typed" },
        });
        yield* queue.save(sessionId, b!.id, "second, edited");
        expect(ids()).toEqual(["first", "second, edited", "third"]);

        yield* queue.remove(sessionId, a!.id);
        yield* queue.edit(sessionId, c!.id, "third, unsaved");
        const restarted = yield* call(() => context.reopen());
        const after = yield* Effect.provideContext(MessageQueue, yield* restarted.contextEffect);
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
        yield* after.confirm(sessionId, b!.id);
        expect(after.deliverable(sessionId).map((message) => message.text)).toEqual([
          "second, edited",
        ]);
        after.markDelivered(b!.id, "next_turn", null, true);
        expect(after.snapshot(sessionId).nextDelivery).toEqual({
          kind: "blocked",
          messageId: c!.id,
          reason: "held",
        });
        yield* after.remove(sessionId, c!.id);
        expect(after.snapshot(sessionId).nextDelivery).toEqual({ kind: "empty" });
      }),
  );

  it.live(
    "a queued message reaches the agent when the next tool call returns",
    () =>
      Effect.gen(function* () {
        const context = yield* setup();
        const tab = yield* openTab(context.runtime, context.session.id);
        void tab.client.sendMessage("please check files");
        yield* until(() => tab.client.getIsLoading(), "the run to start");
        const active = yield* context
          .running()
          .pipe(
            Effect.repeat({ until: isTruthy, schedule: Schedule.spaced(20) }),
            Effect.timeoutOption(1_000),
          );
        expect(Option.isSome(active)).toBe(true);

        const queued = yield* context.enqueue("look in the tests folder", "queue");
        expect(queued.status).toBe(201);
        expect((yield* decodeQueued(queued.body)).state).toEqual({ kind: "waiting" });
        context.releaseDelayedTurn();

        yield* until(
          () => context.provider!.adapter.invocations.length === 2,
          "the provider continuation",
        );
        yield* until(() => !tab.client.getIsLoading(), "the run to finish");
        const continuation = context.provider!.adapter.invocations[1];
        expect(
          continuation?.messages.some(
            (message) => message.role === "user" && message.content === "look in the tests folder",
          ),
        ).toBe(true);
        const [delivered] = yield* context.list();
        expect(delivered?.state).toMatchObject({ kind: "delivered", via: "tool_boundary" });

        const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
        expect(
          nodes
            .session(context.session.id)
            .filter((node) => node.kind === "user")
            .map((n) => n.text),
        ).toEqual(["please check files", "look in the tests folder"]);
        tab.client.dispose();

        // The saved conversation has it too, so the next send does not drop it.
        const reloaded = yield* openTab(context.runtime, context.session.id);
        yield* until(() => reloaded.texts("user").length === 2, "the saved conversation");
        expect(reloaded.texts("user")).toEqual(["please check files", "look in the tests folder"]);
        reloaded.client.dispose();
      }),
    10_000,
  );

  it.live("unavailable steering leaves the message for an explicit queue fallback", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const tab = yield* openTab(context.runtime, context.session.id);
      void tab.client.sendMessage("please be slow");
      yield* until(() => context.provider!.adapter.invocations.length === 1, "the run to start");

      const steered = yield* context.enqueue("shorter please", "steer");
      expect(steered.status).toBe(409);
      expect(steered.body).toEqual({ error: "steer_unavailable" });
      expect(yield* context.list()).toEqual([]);

      const queued = yield* context.enqueue("shorter please", "queue");
      expect(queued.status).toBe(201);
      expect((yield* decodeQueued(queued.body)).state).toEqual({ kind: "waiting" });
      context.releaseDelayedTurn();

      yield* until(() => tab.answer().includes("done"), "the answer to finish");
      yield* until(() => !tab.client.getIsLoading(), "the run to finish");
      const [held] = yield* context.list();
      expect(held?.text).toBe("shorter please");
      expect(held?.state).toEqual({ kind: "held", draft: null });
      tab.client.dispose();

      // With nothing answering there is nothing to queue for or steer into.
      expect((yield* context.enqueue("too late", "steer")).status).toBe(409);
      expect((yield* context.enqueue("too late", "queue")).status).toBe(409);
    }),
  );

  it.live("after a normal finish the page sends the next queued message as a turn", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      // The page holds the session, so waiting messages are left for it to send.
      yield* context.agent.lease(context.session.id, "tab", "claim");
      const tab = yield* openTab(context.runtime, context.session.id, "tab");
      void tab.client.sendMessage("please be slow");
      yield* until(() => context.provider!.adapter.invocations.length === 1, "the answer to start");
      const first = yield* decodeQueued(
        (yield* context.enqueue("hello again", "queue", "tab")).body,
      );
      const second = yield* decodeQueued(
        (yield* context.enqueue("and once more", "queue", "tab")).body,
      );
      context.releaseDelayedTurn();
      yield* until(() => tab.answer().includes("done"), "the first answer");
      yield* until(() => !tab.client.getIsLoading(), "the run to finish");
      // No tool call happened, so both are still waiting for the page.
      expect((yield* context.list()).map((message) => message.state.kind)).toEqual([
        "waiting",
        "waiting",
      ]);

      // Supplying an ID is no longer a valid request; the server alone picks the head.
      yield* call(() => tab.client.sendMessage("and once more", { queuedMessageId: second.id }));
      expect(tab.client.getError()?.message).toContain("400");

      // A snapshot captured `first`, but the server must select the current head after an edit.
      const edited = yield* context.agent.editQueued(context.session.id, "tab", first.id, {
        action: "save",
        text: "hello, freshly edited",
      });
      expect(edited.status).toBe(200);
      yield* call(() => tab.client.sendMessage("stale client placeholder", { queuedNext: true }));
      yield* until(() => tab.answer().includes("Hello from fast-1"), "the next turn");
      yield* until(() => !tab.client.getIsLoading(), "the next turn to finish");
      const states = (yield* context.list()).map((message) => [message.text, message.state.kind]);
      expect(states).toEqual([
        ["hello, freshly edited", "delivered"],
        ["and once more", "waiting"],
      ]);
      const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
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
    }),
  );

  it.live("queuedNext refuses an empty queue without persisting the placeholder", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const tab = yield* openTab(context.runtime, context.session.id);
      yield* call(() => tab.client.sendMessage("placeholder", { queuedNext: true }));
      expect(tab.client.getError()?.message).toContain("409");
      const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
      expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toEqual([]);
      tab.client.dispose();
    }),
  );

  it.live("a cancel holds what was waiting until the user confirms it", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const tab = yield* openTab(context.runtime, context.session.id);
      void tab.client.sendMessage("please be slow");
      yield* until(() => context.provider!.adapter.invocations.length === 1, "the answer to start");
      yield* context.enqueue("never mind", "queue");
      yield* context.agent.cancel(context.session.id, null);
      yield* until(() => !tab.client.getIsLoading(), "the run to stop");
      expect(context.provider!.adapter.invocations).toHaveLength(1);
      tab.client.stop();

      const [held] = yield* context.list();
      expect(held?.state).toEqual({ kind: "held", draft: null });
      const confirmed = yield* context.agent.editQueued(context.session.id, null, held!.id, {
        action: "confirm",
      });
      expect((yield* decodeQueued(yield* call(() => confirmed.json()))).state).toEqual({
        kind: "waiting",
      });
      tab.client.dispose();
    }),
  );
});

const call = <A>(execute: () => A) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
