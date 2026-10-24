import { Effect, Option, Schedule, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { MessageQueue } from "../../src/queue/queue.ts";
import { NextDelivery, QueueEdit, QueueItemState } from "../../src/queue/queue-state.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import {
  agentChat,
  current,
  freshSession,
  gatedResponder,
  holdDelayedTurns,
  invocationsOf,
  json,
  openTab,
  sdk,
  until,
  userTexts,
} from "./tab.ts";

const Decision = Schema.Struct({ allowed: Schema.Boolean, reason: Schema.optional(Schema.String) });
const Status = Schema.Struct({
  actions: Schema.Struct({
    phases: Schema.Record(Schema.String, Decision),
    controls: Schema.Record(Schema.String, Decision),
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
const Queued = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  state: Schema.TaggedUnion({
    waiting: { steered: Schema.Boolean },
    editing: { draft: Schema.String },
    held: { draft: Schema.NullOr(Schema.String) },
    delivered: {
      via: Schema.Literals(["tool_boundary", "steer", "next_turn"]),
      runId: Schema.NullOr(Schema.String),
    },
    failed: { reason: Schema.String },
  }),
});
const QueueSnapshot = Schema.Struct({
  items: Schema.Array(Queued),
  nextDelivery: Schema.TaggedUnion({
    ready: {},
    server: {},
    blocked: { messageId: Schema.String, reason: Schema.Literals(["editing", "held"]) },
    empty: {},
  }),
});
const decodeQueued = Schema.decodeUnknownEffect(Queued);
/** The state's case name, for comparing a queue's order at a glance. */
const stateName = QueueItemState.$match({
  waiting: () => "waiting",
  editing: () => "editing",
  held: () => "held",
  delivered: () => "delivered",
  failed: () => "failed",
});

/** A fresh session with a chosen model whose delayed model turns wait for `release`. */
const chatSession = Effect.gen(function* () {
  yield* current(selectTestModel());
  const id = yield* freshSession;
  const release = yield* holdDelayedTurns(id);
  return { id, release, invocations: yield* invocationsOf(id) };
});

const statusOf = (sessionId: string) =>
  Effect.flatMap(agentChat, (agent) => agent.status(sessionId, null)).pipe(
    Effect.flatMap(json),
    Effect.flatMap(Schema.decodeUnknownEffect(Status)),
  );

const queueOf = (sessionId: string) =>
  Effect.flatMap(agentChat, (agent) => agent.queued(sessionId)).pipe(
    Effect.flatMap(json),
    Effect.flatMap(Schema.decodeUnknownEffect(QueueSnapshot)),
  );

const enqueue = Effect.fnUntraced(function* (
  sessionId: string,
  text: string,
  mode: "queue" | "steer",
  holder: string | null = null,
) {
  const response = yield* Effect.flatMap(agentChat, (agent) =>
    agent.enqueue(sessionId, holder, { text, attachmentIds: [], mode }),
  );
  return { status: response.status, body: yield* json(response) };
});

/** Send from the tab without waiting: the send only settles once the run does. */
const sendInBackground = (tab: Effect.Success<ReturnType<typeof openTab>>, text: string) =>
  Effect.forkChild(
    sdk(() => tab.client.sendMessage(text)),
    { startImmediately: true },
  );

testAgent({ testProvider: { responder: gatedResponder } })("chat runs", (it) => {
  it.effect("a reloaded page rejoins a durable app run without invoking the provider again", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const first = yield* openTab(session.id);
      yield* sendInBackground(first, "please be slow");
      yield* until(() => session.invocations().length === 1, "the provider run to start");
      // The tab reloads mid-answer.
      first.client.dispose();
      const second = yield* openTab(session.id);
      yield* session.release;
      yield* until(() => second.answer().endsWith("done"), "the rest of the answer");
      expect(second.answer()).toBe("done");
      yield* until(() => !second.client.getSessionGenerating(), "the rejoined run to settle");
      expect(session.invocations()).toHaveLength(1);
      expect((yield* statusOf(session.id)).lastRun?.status).toBe("completed");
    }),
  );

  it.effect("cancel stops the running run and reports that it really stopped", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const tab = yield* openTab(session.id);
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the provider run to start");
      const running = yield* statusOf(session.id);
      expect(running.running).not.toBeNull();
      for (const decision of Object.values(running.actions.phases))
        expect(decision).toEqual({ allowed: false, reason: "run_in_progress" });
      expect(running.actions.controls.resume).toEqual({
        allowed: false,
        reason: "run_in_progress",
      });
      const refused = yield* agent.setWorkflowPhase(session.id, null, "plan");
      expect(refused.status).toBe(409);
      expect(yield* json(refused)).toEqual({ error: "run_in_progress" });
      const cancelled = yield* Schema.decodeUnknownEffect(Cancelled)(
        yield* json(yield* agent.cancel(session.id, null)),
      );
      expect(cancelled).toMatchObject({ stopped: true, status: "aborted" });
      expect(session.invocations()).toHaveLength(1);
      expect(tab.answer()).not.toContain("done");
      const status = yield* statusOf(session.id);
      expect(status.running).toBeNull();
      expect(status.lastRun?.status).toBe("aborted");
      // Nothing is running any more, so a second cancel has nothing to stop.
      expect((yield* agent.cancel(session.id, null)).status).toBe(409);
      const seen = tab.answer();
      tab.client.dispose();
      // A reload shows exactly the durable text saved before cancellation and does not rerun it.
      const reloaded = yield* openTab(session.id);
      yield* until(() => reloaded.client.getMessages().length > 0, "the stored transcript");
      expect(reloaded.answer()).toBe(seen);
      expect(session.invocations()).toHaveLength(1);
    }),
  );

  it.effect("cancel stops a running Plan-phase run without changing its workflow phase", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      expect((yield* agent.setWorkflowPhase(session.id, null, "plan")).status).toBe(200);
      const tab = yield* openTab(session.id);
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the Plan run to start");
      const running = yield* statusOf(session.id);
      expect(running.running).not.toBeNull();
      expect(running.actions.phases.plan).toEqual({ allowed: false, reason: "run_in_progress" });
      const response = yield* agent.cancel(session.id, null);
      expect(response.status).toBe(200);
      expect(yield* Schema.decodeUnknownEffect(Cancelled)(yield* json(response))).toMatchObject({
        runId: running.running!.runId,
        stopped: true,
        status: "aborted",
      });
      const stopped = yield* statusOf(session.id);
      expect(stopped.running).toBeNull();
      expect(stopped.lastRun).toMatchObject({ runId: running.running!.runId, status: "aborted" });
      expect(stopped.actions.phases.plan).toEqual({ allowed: true });
      expect((yield* (yield* Workflows).get(session.id)).phase).toBe("plan");
    }),
  );

  it.effect("a second run in the same session is refused while the first is answering", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const tab = yield* openTab(session.id);
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the first run to start");
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        threadId: session.id,
        runId: `${session.id}-second`,
        state: {},
        messages: [{ id: "m-2", role: "user", parts: [{ type: "text", content: "hi" }] }],
        tools: [],
        context: [],
        forwardedProps: {},
      });
      const response = yield* agent.handle(
        new Request(`http://127.0.0.1/api/chat?session=${session.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        session.id,
      );
      expect(response.status).toBe(409);
      yield* agent.cancel(session.id, null);
    }),
  );
});

testAgent({ testProvider: { responder: gatedResponder } })("message queue", (it) => {
  it.effect("claim reserves the head against mutations, then release and delivery clear it", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const queue = yield* MessageQueue;
      const first = yield* queue.add(sessionId, "first", [], false);
      const second = yield* queue.add(sessionId, "second", [], false);
      expect((yield* queue.claimNext(sessionId))?.id).toBe(first.id);
      expect(yield* queue.claimNext(sessionId)).toBeNull();
      for (const change of [
        queue.edit(sessionId, first.id, "draft"),
        queue.save(sessionId, first.id, "changed"),
        queue.remove(sessionId, first.id),
        queue.confirm(sessionId, first.id),
      ]) {
        expect(yield* Effect.flip(change)).toMatchObject({ reason: "reserved" });
      }
      expect((yield* queue.get(sessionId, first.id))?.text).toBe("first");
      yield* queue.releaseNext(sessionId, "wrong-id");
      expect(yield* queue.claimNext(sessionId)).toBeNull();
      yield* queue.releaseNext(sessionId, first.id);
      expect((yield* queue.claimNext(sessionId))?.id).toBe(first.id);
      yield* queue.markDelivered(first.id, "next_turn", null);
      expect((yield* queue.claimNext(sessionId))?.id).toBe(second.id);
    }),
  );

  it.effect(
    "claim only decodes the first pending item, respecting barriers and terminal entries",
    () =>
      Effect.gen(function* () {
        const sessionId = yield* freshSession;
        const queue = yield* MessageQueue;
        const terminal = yield* queue.add(sessionId, "already delivered", [], false);
        yield* queue.markDelivered(terminal.id, "next_turn", null);
        const failed = yield* queue.add(sessionId, "already failed", [], false);
        yield* queue.markFailed(failed.id, "unavailable");
        expect(yield* queue.deliverable(sessionId)).toEqual([]);
        const barrier = yield* queue.add(sessionId, "editing", [], false);
        const next = yield* queue.add(sessionId, "waiting", [], false);
        yield* queue.edit(sessionId, barrier.id, "draft");
        expect((yield* queue.snapshot(sessionId)).nextDelivery).toEqual(
          NextDelivery.blocked({ messageId: barrier.id, reason: "editing" }),
        );
        expect(yield* queue.claimNext(sessionId)).toBeNull();
        expect(yield* queue.deliverable(sessionId)).toEqual([]);
        yield* queue.remove(sessionId, barrier.id);
        expect((yield* queue.snapshot(sessionId)).nextDelivery).toEqual(NextDelivery.ready());
        expect((yield* queue.deliverable(sessionId)).map((message) => message.id)).toEqual([
          next.id,
        ]);
        expect((yield* queue.claimNext(sessionId))?.id).toBe(next.id);
      }),
  );

  it.effect("tool boundary streams only the waiting prefix across terminal rows", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const queue = yield* MessageQueue;
      const first = yield* queue.add(sessionId, "first", [], false);
      const delivered = yield* queue.add(sessionId, "delivered", [], false);
      yield* queue.markDelivered(delivered.id, "tool_boundary", null);
      const failed = yield* queue.add(sessionId, "failed", [], false);
      yield* queue.markFailed(failed.id, "unavailable");
      const second = yield* queue.add(sessionId, "second", [], false);
      const barrier = yield* queue.add(sessionId, "held", [], false);
      const behind = yield* queue.add(sessionId, "behind", [], false);
      yield* queue.holdWaiting(sessionId, "stopped");
      yield* queue.confirm(sessionId, first.id);
      yield* queue.confirm(sessionId, second.id);
      expect((yield* queue.deliverable(sessionId)).map((item) => item.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect((yield* queue.claimNext(sessionId))?.id).toBe(first.id);
      yield* queue.releaseNext(sessionId, first.id);
      yield* queue.confirm(sessionId, barrier.id);
      yield* queue.confirm(sessionId, behind.id);
      expect((yield* queue.deliverable(sessionId)).map((item) => item.id)).toEqual([
        first.id,
        second.id,
        barrier.id,
        behind.id,
      ]);
    }),
  );

  it.effect("holding during a claim keeps the item held after release", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const queue = yield* MessageQueue;
      const item = yield* queue.add(sessionId, "first", [], false);
      expect((yield* queue.claimNext(sessionId))?.id).toBe(item.id);
      yield* queue.holdWaiting(sessionId, "stopped");
      expect((yield* queue.get(sessionId, item.id))?.state).toEqual(
        QueueItemState.waiting({ steered: false }),
      );
      expect(yield* queue.claimNext(sessionId)).toBeNull();
      yield* queue.releaseNext(sessionId, item.id);
      expect((yield* queue.get(sessionId, item.id))?.state).toEqual(
        QueueItemState.held({ draft: null }),
      );
      expect(yield* queue.claimNext(sessionId)).toBeNull();
      yield* queue.confirm(sessionId, item.id);
      expect((yield* queue.claimNext(sessionId))?.id).toBe(item.id);
    }),
  );

  it.effect("queue endpoint returns the server-owned snapshot contract", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const queue = yield* MessageQueue;
      expect(yield* queueOf(sessionId)).toMatchObject({
        items: [],
        nextDelivery: NextDelivery.empty(),
      });
      const first = yield* queue.add(sessionId, "first", [], false);
      const second = yield* queue.add(sessionId, "second", [], false);
      expect(yield* queueOf(sessionId)).toMatchObject({
        items: [{ id: first.id }, { id: second.id }],
        nextDelivery: NextDelivery.ready(),
      });
      yield* queue.edit(sessionId, first.id, "draft");
      expect((yield* queueOf(sessionId)).nextDelivery).toEqual(
        NextDelivery.blocked({ messageId: first.id, reason: "editing" }),
      );
    }),
  );

  it.effect(
    "server-authoritative turns persist once instead of resending the whole transcript",
    () =>
      Effect.gen(function* () {
        const session = yield* chatSession;
        const tab = yield* openTab(session.id);
        yield* sdk(() => tab.client.sendMessage("first turn"));
        yield* until(() => !tab.client.getIsLoading(), "the first turn to finish");
        yield* sdk(() => tab.client.sendMessage("second turn"));
        yield* until(() => !tab.client.getIsLoading(), "the second turn to finish");

        const reloaded = yield* openTab(session.id);
        yield* until(() => reloaded.texts("user").length > 0, "the persisted turns");
        expect(reloaded.texts("user")).toEqual(["first turn", "second turn"]);
      }),
    15_000,
  );

  it.effect("a queued message reaches the agent when the next tool call returns", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const tab = yield* openTab(session.id);
      yield* sendInBackground(tab, "please check files");
      const active = yield* statusOf(session.id).pipe(
        Effect.repeat({
          until: (status) => status.running !== null,
          schedule: Schedule.spaced(20),
        }),
        Effect.timeoutOption(1_000),
      );
      expect(Option.isSome(active)).toBe(true);

      const queued = yield* enqueue(session.id, "look in the tests folder", "queue");
      expect(queued.status).toBe(201);
      expect((yield* decodeQueued(queued.body)).state).toEqual(
        QueueItemState.waiting({ steered: false }),
      );
      yield* session.release;

      yield* until(() => session.invocations().length === 2, "the provider continuation");
      yield* until(() => !tab.client.getIsLoading(), "the run to finish");
      expect(
        session
          .invocations()[1]
          ?.messages.some(
            (message) => message.role === "user" && message.content === "look in the tests folder",
          ),
      ).toBe(true);
      const [delivered] = (yield* queueOf(session.id)).items;
      expect(
        delivered !== undefined &&
          QueueItemState.$is("delivered")(delivered.state) &&
          delivered.state.via,
      ).toBe("tool_boundary");
      expect(yield* userTexts(session.id)).toEqual([
        "please check files",
        "look in the tests folder",
      ]);
      tab.client.dispose();

      // The saved conversation has it too, so the next send does not drop it.
      const reloaded = yield* openTab(session.id);
      yield* until(() => reloaded.texts("user").length === 2, "the saved conversation");
      expect(reloaded.texts("user")).toEqual(["please check files", "look in the tests folder"]);
    }),
  );

  it.effect("steering cuts the answer and the server sends the messages next", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const tab = yield* openTab(session.id);
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the run to start");
      // No page holds the session afterwards: only the server can send what follows.
      tab.client.dispose();

      // Steering takes the message waiting before it along, so the order holds.
      yield* enqueue(session.id, "and the tests", "queue");
      expect((yield* enqueue(session.id, "shorter please", "steer")).status).toBe(201);

      // The slow answer is never released: the cut ends it, then each message is a turn.
      yield* until(() => session.invocations().length === 3, "both steered turns");
      expect(session.invocations().map((invocation) => invocation.messages.at(-1))).toMatchObject([
        { role: "user", content: "please be slow" },
        { role: "user", content: "and the tests" },
        { role: "user", content: "shorter please" },
      ]);
      yield* statusOf(session.id).pipe(
        Effect.repeat({
          until: (status) => status.running === null && status.lastRun?.status === "completed",
          schedule: Schedule.spaced(20),
        }),
      );
      expect((yield* queueOf(session.id)).nextDelivery).toEqual(NextDelivery.empty());
      expect(yield* userTexts(session.id)).toEqual([
        "please be slow",
        "and the tests",
        "shorter please",
      ]);

      // With nothing answering there is nothing to queue for or steer into.
      expect((yield* enqueue(session.id, "too late", "steer")).status).toBe(409);
    }),
  );

  it.effect("after a normal finish the page sends the next queued message as a turn", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      // The page holds the session, so waiting messages are left for it to send.
      yield* agent.lease(session.id, "tab", "claim");
      const tab = yield* openTab(session.id, "tab");
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the answer to start");
      const first = yield* decodeQueued(
        (yield* enqueue(session.id, "hello again", "queue", "tab")).body,
      );
      const second = yield* decodeQueued(
        (yield* enqueue(session.id, "and once more", "queue", "tab")).body,
      );
      yield* session.release;
      yield* until(() => tab.answer().includes("done"), "the first answer");
      yield* until(() => !tab.client.getIsLoading(), "the run to finish");
      // No tool call happened, so both are still waiting for the page.
      expect((yield* queueOf(session.id)).items.map((message) => stateName(message.state))).toEqual(
        ["waiting", "waiting"],
      );

      // Supplying an ID is no longer a valid request; the server alone picks the head.
      yield* sdk(() => tab.client.sendMessage("and once more", { queuedMessageId: second.id }));
      expect(tab.client.getError()?.message).toContain("400");

      // A snapshot captured `first`, but the server must select the current head after an edit.
      const edited = yield* agent.editQueued(
        session.id,
        "tab",
        first.id,
        QueueEdit.save({ text: "hello, freshly edited" }),
      );
      expect(edited.status).toBe(200);
      yield* sdk(() => tab.client.sendMessage("stale client placeholder", { queuedNext: true }));
      yield* until(() => tab.answer().includes("Hello from fast-1"), "the next turn");
      yield* until(() => !tab.client.getIsLoading(), "the next turn to finish");
      expect(
        (yield* queueOf(session.id)).items.map((message) => [
          message.text,
          stateName(message.state),
        ]),
      ).toEqual([
        ["hello, freshly edited", "delivered"],
        ["and once more", "waiting"],
      ]);
      expect(yield* userTexts(session.id)).toEqual(["please be slow", "hello, freshly edited"]);
      expect(
        session
          .invocations()[1]
          ?.messages.some(
            (message) => message.role === "user" && message.content === "hello, freshly edited",
          ),
      ).toBe(true);
    }),
  );

  it.effect.each([{ head: "empty" }, { head: "editing" }] as const)(
    "queuedNext with a $head head is refused before POST without recording the placeholder",
    ({ head }) =>
      Effect.gen(function* () {
        const session = yield* chatSession;
        const queue = yield* MessageQueue;
        const blocked = Effect.gen(function* () {
          switch (head) {
            case "empty":
              return null;
            case "editing": {
              // The page saw a ready head, then the user started editing it.
              const item = yield* queue.add(session.id, "previously ready", [], false);
              expect((yield* queue.snapshot(session.id)).nextDelivery).toEqual(
                NextDelivery.ready(),
              );
              yield* queue.edit(session.id, item.id, "unsaved draft");
              return item.id;
            }
          }
        });
        const item = yield* blocked;
        const tab = yield* openTab(session.id);
        yield* sdk(() => tab.client.sendMessage("stale client placeholder", { queuedNext: true }));
        expect(tab.client.getError()?.message).toContain("409");
        if (item !== null)
          expect((yield* queue.get(session.id, item))?.state).toEqual(
            QueueItemState.editing({ draft: "unsaved draft" }),
          );
        expect(yield* userTexts(session.id)).toEqual([]);
      }),
  );

  it.effect("queuedNext selects the latest queue head and ignores stale client text", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const queue = yield* MessageQueue;
      const stale = yield* queue.add(session.id, "original", [], false);
      yield* queue.add(session.id, "second", [], false);
      yield* queue.save(session.id, stale.id, "edited on server");
      const tab = yield* openTab(session.id);
      yield* sdk(() => tab.client.sendMessage({ content: [] }, { queuedNext: true }));
      yield* until(() => !tab.client.getIsLoading(), "the run to finish");
      expect(tab.client.getError()).toBeUndefined();
      const staleState = (yield* queue.get(session.id, stale.id))?.state;
      expect(
        staleState !== undefined && QueueItemState.$is("delivered")(staleState) && staleState.via,
      ).toBe("next_turn");
      expect(yield* userTexts(session.id)).toEqual(["edited on server"]);
      expect(
        session
          .invocations()[0]
          ?.messages.some(
            (message) => message.role === "user" && message.content === "edited on server",
          ),
      ).toBe(true);
      const chatState = yield* ChatState;
      const stored = yield* sdk(() => chatState.persistence.stores.messages.loadThread(session.id));
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
      const hydrated = yield* (yield* agentChat).hydrate(
        new Request(`http://127.0.0.1/api/chat?session=${session.id}&threadId=${session.id}`),
        session.id,
      );
      const history = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      )(yield* json(hydrated));
      expect(history.messages.some((message) => message.id === stale.id)).toBe(true);
    }),
  );

  it.effect("a failed queue settlement holds what was waiting until the user confirms it", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const chatState = yield* ChatState;
      // The page holds the session, so a settled finish would leave the message waiting for it.
      yield* agent.lease(session.id, "tab", "claim");
      const tab = yield* openTab(session.id, "tab");
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the answer to start");
      yield* enqueue(session.id, "and the tests", "queue", "tab");
      const runId = (yield* statusOf(session.id)).running!.runId;
      const original = chatState.run;
      const lookup = vi
        .spyOn(chatState, "run")
        .mockImplementation((sessionId, id) =>
          id === runId ? Promise.reject(new Error("store unavailable")) : original(sessionId, id),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => lookup.mockRestore()));
      yield* session.release;
      yield* until(() => !tab.client.getIsLoading(), "the run to finish");
      expect(tab.client.getError()).toBeUndefined();
      yield* queueOf(session.id).pipe(
        Effect.repeat({
          until: (snapshot) =>
            snapshot.items[0] !== undefined && QueueItemState.$is("held")(snapshot.items[0].state),
          schedule: Schedule.spaced(20),
        }),
      );
    }),
  );

  it.effect("a cancel holds what was waiting until the user confirms it", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const tab = yield* openTab(session.id);
      yield* sendInBackground(tab, "please be slow");
      yield* until(() => session.invocations().length === 1, "the answer to start");
      yield* enqueue(session.id, "never mind", "queue");
      yield* agent.cancel(session.id, null);
      yield* until(() => !tab.client.getIsLoading(), "the run to stop");
      expect(session.invocations()).toHaveLength(1);
      tab.client.stop();

      const [held] = (yield* queueOf(session.id)).items;
      expect(held?.state).toEqual(QueueItemState.held({ draft: null }));
      const confirmed = yield* agent.editQueued(session.id, null, held!.id, QueueEdit.confirm());
      expect((yield* decodeQueued(yield* json(confirmed))).state).toEqual(
        QueueItemState.waiting({ steered: false }),
      );
    }),
  );
});

// Reopening replaces the agent, so these tests reach every service through `env.use`.
testAgent({ testProvider: { responder: gatedResponder } })("chat across restarts", (it) => {
  it.effect(
    "queue order holds behind a message being edited, and a restart holds everything for confirmation",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const sessionId = yield* freshSession;
        const queue = yield* current(MessageQueue);
        const [a, b, c] = yield* Effect.forEach(["first", "second", "third"], (text) =>
          queue.add(sessionId, text, [], false),
        );
        const texts = Effect.map(queue.deliverable(sessionId), (found) =>
          found.map((message) => message.text),
        );

        expect(yield* texts).toEqual(["first", "second", "third"]);
        expect((yield* queue.snapshot(sessionId)).nextDelivery).toEqual(NextDelivery.ready());
        yield* queue.edit(sessionId, b!.id, "second, half typed");
        // The edited message and everything after it wait; unsaved text is not the message.
        expect(yield* texts).toEqual(["first"]);
        expect((yield* queue.snapshot(sessionId)).nextDelivery).toEqual(NextDelivery.ready());
        // A snapshot is advisory: delivery reselects after each edit.
        yield* queue.edit(sessionId, a!.id, "first draft");
        expect((yield* queue.snapshot(sessionId)).nextDelivery).toEqual(
          NextDelivery.blocked({ messageId: a!.id, reason: "editing" }),
        );
        expect(yield* queue.deliverable(sessionId)).toEqual([]);
        yield* queue.save(sessionId, a!.id, "first");
        expect(yield* queue.get(sessionId, b!.id)).toMatchObject({
          text: "second",
          state: QueueItemState.editing({ draft: "second, half typed" }),
        });
        yield* queue.save(sessionId, b!.id, "second, edited");
        expect(yield* texts).toEqual(["first", "second, edited", "third"]);

        yield* queue.remove(sessionId, a!.id);
        yield* queue.edit(sessionId, c!.id, "third, unsaved");
        yield* env.reopen;
        const after = yield* current(MessageQueue);
        // Nothing goes out on its own after a restart; the unsaved edit is kept as a draft.
        expect(yield* after.deliverable(sessionId)).toEqual([]);
        expect((yield* after.snapshot(sessionId)).nextDelivery).toEqual(
          NextDelivery.blocked({ messageId: b!.id, reason: "held" }),
        );
        expect((yield* after.list(sessionId, null)).map((message) => message.state)).toEqual([
          QueueItemState.held({ draft: null }),
          QueueItemState.held({ draft: "third, unsaved" }),
        ]);
        yield* after.confirm(sessionId, b!.id);
        expect((yield* after.deliverable(sessionId)).map((message) => message.text)).toEqual([
          "second, edited",
        ]);
        yield* after.markDelivered(b!.id, "next_turn", null);
        expect((yield* after.snapshot(sessionId)).nextDelivery).toEqual(
          NextDelivery.blocked({ messageId: c!.id, reason: "held" }),
        );
        yield* after.remove(sessionId, c!.id);
        expect((yield* after.snapshot(sessionId)).nextDelivery).toEqual(NextDelivery.empty());
      }),
  );

  it.effect.each([
    { interrupted: "answer", message: "please be slow" },
    { interrupted: "approval", message: "please use the shell" },
  ] as const)(
    "a restart during an unfinished $interrupted marks the run failed without resuming or rerunning it",
    ({ interrupted, message }) =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const session = yield* chatSession;
        const tab = yield* openTab(session.id);
        yield* sendInBackground(tab, message);
        switch (interrupted) {
          case "answer":
            yield* until(() => session.invocations().length === 1, "the run to be answering");
            break;
          case "approval":
            // Approval pauses the request, so wait for the interrupt rather than for the send.
            yield* until(() => tab.client.getInterrupts().length === 1, "the approval request");
            break;
        }
        tab.client.dispose();
        const asked = session.invocations().length;
        yield* env.reopen;
        expect(yield* statusOf(session.id)).toMatchObject({
          running: null,
          lastRun: { status: "failed", error: { code: "server_restarted" } },
        });
        // No run or approval is offered again, and the provider was not asked to start anything.
        const reloaded = yield* openTab(session.id);
        yield* until(() => reloaded.client.getMessages().length > 0, "the stored transcript");
        expect(reloaded.client.getSessionGenerating()).toBe(false);
        expect(reloaded.client.getInterrupts()).toEqual([]);
        expect(reloaded.client.getError()).toBeUndefined();
        expect(session.invocations()).toHaveLength(asked);
      }),
  );
});
