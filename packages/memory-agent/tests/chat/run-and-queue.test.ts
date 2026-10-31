import { Effect, Fiber, Option, Schedule, Schema } from "effect";
import { SqlError } from "effect/sql";
import { expect, vi } from "vite-plus/test";
import { ChatMessage } from "../../src/api/chat-api.ts";
import { RunStore } from "../../src/loop/store.ts";
import { MessageQueue } from "../../src/queue/queue.ts";
import { NextDelivery, QueueEdit, QueueItemState } from "../../src/queue/queue-state.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { type ChatPage, openPage, runTurn } from "../support/chat-client.ts";
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
  Effect.flatMap(agentChat, (agent) => agent.queued(sessionId));

const enqueue = (
  sessionId: string,
  text: string,
  mode: "queue" | "steer",
  holder: string | null = null,
) =>
  Effect.flatMap(agentChat, (agent) =>
    agent.enqueue(sessionId, holder, { text, attachmentIds: [], mode }),
  );

/** Send from the page without waiting: the send settles only once the run's stream ends. */
const sendInBackground = (page: ChatPage, text: string) =>
  Effect.forkChild(page.send(text), { startImmediately: true });

testAgent({ testProvider: { responder: gatedResponder } })("chat runs", (it) => {
  it.effect("a reloaded page rejoins a durable app run without invoking the provider again", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const first = yield* openPage(session.id);
      const sending = yield* sendInBackground(first, "please be slow");
      yield* until(() => session.invocations().length === 1, "the provider run to start");
      // The tab reloads mid-answer.
      yield* Fiber.interrupt(sending);
      const second = yield* openPage(session.id);
      yield* session.release;
      yield* second.rejoin;
      expect(second.answer()).toBe("done");
      expect(session.invocations()).toHaveLength(1);
      expect((yield* statusOf(session.id)).lastRun?.status).toBe("completed");
    }),
  );

  it.effect("a turn whose page leaves before its run starts still reaches the conversation", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const starting = yield* Effect.forkChild(
        agent.start(
          {
            holder: null,
            input: {
              runId: `${session.id}-left`,
              messages: [{ id: "m-1", role: "user", content: "hi" }],
            },
          },
          session.id,
          null,
        ),
        { startImmediately: true },
      );
      // The request ends before the turn has a run.
      yield* Fiber.interrupt(starting);
      yield* until(() => session.invocations().length === 1, "the turn's run to start");
      const reloaded = yield* openPage(session.id);
      yield* reloaded.rejoin;
      expect(reloaded.texts("user")).toEqual(["hi"]);
    }),
  );

  it.effect("cancel stops the running run and reports that it really stopped", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const page = yield* openPage(session.id);
      const sending = yield* sendInBackground(page, "please be slow");
      yield* until(() => session.invocations().length === 1, "the provider run to start");
      const running = yield* statusOf(session.id);
      expect(running.running).not.toBeNull();
      Object.values(running.actions.phases).forEach((decision) => {
        expect(decision).toEqual({ allowed: false, reason: "run_in_progress" });
      });
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
      yield* Fiber.join(sending);
      expect(session.invocations()).toHaveLength(1);
      expect(page.answer()).not.toContain("done");
      const status = yield* statusOf(session.id);
      expect(status.running).toBeNull();
      expect(status.lastRun?.status).toBe("aborted");
      // Nothing is running any more, so a second cancel has nothing to stop.
      expect((yield* agent.cancel(session.id, null)).status).toBe(409);
      // A reload shows exactly the durable text saved before cancellation and does not rerun it.
      const reloaded = yield* openPage(session.id);
      expect(reloaded.view().messages.length).toBeGreaterThan(0);
      expect(reloaded.answer()).toBe(page.answer());
      expect(session.invocations()).toHaveLength(1);
    }),
  );

  it.effect("cancel stops a running Plan-phase run without changing its workflow phase", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      expect((yield* agent.setWorkflowPhase(session.id, null, "plan")).status).toBe(200);
      yield* sendInBackground(yield* openPage(session.id), "please be slow");
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
      yield* sendInBackground(yield* openPage(session.id), "please be slow");
      yield* until(() => session.invocations().length === 1, "the first run to start");
      expect(yield* Effect.flip(runTurn(session.id, `${session.id}-second`, "hi"))).toMatchObject({
        error: "run_in_progress",
      });
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
      yield* Effect.forEach(
        [
          queue.edit(sessionId, first.id, "draft"),
          queue.save(sessionId, first.id, "changed"),
          queue.remove(sessionId, first.id),
          queue.confirm(sessionId, first.id),
        ],
        Effect.fnUntraced(function* (change) {
          expect(yield* Effect.flip(change)).toMatchObject({ reason: "reserved" });
        }),
        { discard: true },
      );
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
        const page = yield* openPage(session.id);
        yield* page.send("first turn");
        yield* page.send("second turn");

        const reloaded = yield* openPage(session.id);
        expect(reloaded.texts("user")).toEqual(["first turn", "second turn"]);
      }),
    15_000,
  );

  it.effect("a queued message reaches the agent when the next tool call returns", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const sending = yield* sendInBackground(yield* openPage(session.id), "please check files");
      const active = yield* statusOf(session.id).pipe(
        Effect.repeat({
          until: (status) => status.running !== null,
          schedule: Schedule.spaced(20),
        }),
        Effect.timeoutOption(1_000),
      );
      expect(Option.isSome(active)).toBe(true);

      const queued = yield* enqueue(session.id, "look in the tests folder", "queue");
      expect(queued.state).toEqual(QueueItemState.waiting({ steered: false }));
      yield* session.release;

      yield* Fiber.join(sending);
      expect(session.invocations()).toHaveLength(2);
      expect(
        session
          .invocations()[1]
          ?.history.some(
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

      // The saved conversation has it too, so the next send does not drop it.
      const reloaded = yield* openPage(session.id);
      expect(reloaded.texts("user")).toEqual(["please check files", "look in the tests folder"]);
    }),
  );

  it.effect("steering cuts the answer and the server sends the messages next", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const sending = yield* sendInBackground(yield* openPage(session.id), "please be slow");
      yield* until(() => session.invocations().length === 1, "the run to start");
      // No page holds the session afterwards: only the server can send what follows.
      yield* Fiber.interrupt(sending);

      // Steering takes the message waiting before it along, so the order holds.
      yield* enqueue(session.id, "and the tests", "queue");
      yield* enqueue(session.id, "shorter please", "steer");

      // The slow answer is never released: the cut ends it, then each message is a turn.
      yield* until(() => session.invocations().length === 3, "both steered turns");
      expect(session.invocations().map((invocation) => invocation.history.at(-1))).toMatchObject([
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
      expect(yield* Effect.flip(enqueue(session.id, "too late", "steer"))).toEqual({
        error: "not_running",
      });
    }),
  );

  it.effect("after a normal finish the page sends the next queued message as a turn", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      // The page holds the session, so waiting messages are left for it to send.
      yield* agent.lease(session.id, "tab", "claim");
      const page = yield* openPage(session.id, "tab");
      const sending = yield* sendInBackground(page, "please be slow");
      yield* until(() => session.invocations().length === 1, "the answer to start");
      const first = yield* enqueue(session.id, "hello again", "queue", "tab");
      yield* enqueue(session.id, "and once more", "queue", "tab");
      yield* session.release;
      yield* Fiber.join(sending);
      expect(page.answer()).toContain("done");
      // No tool call happened, so both are still waiting for the page.
      expect((yield* queueOf(session.id)).items.map((message) => stateName(message.state))).toEqual(
        ["waiting", "waiting"],
      );

      // A snapshot captured `first`, but the server must select the current head after an edit.
      yield* agent.editQueued(
        session.id,
        "tab",
        first.id,
        QueueEdit.save({ text: "hello, freshly edited" }),
      );
      yield* page.send("stale client placeholder", { queuedNext: true });
      expect(page.answer()).toContain("Hello from fast-1");
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
          ?.history.some(
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
        const page = yield* openPage(session.id);
        expect(
          yield* Effect.flip(page.send("stale client placeholder", { queuedNext: true })),
        ).toEqual({ error: "queued_message_not_next" });
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
      const page = yield* openPage(session.id);
      yield* page.send([], { queuedNext: true });
      const staleState = (yield* queue.get(session.id, stale.id))?.state;
      expect(
        staleState !== undefined && QueueItemState.$is("delivered")(staleState) && staleState.via,
      ).toBe("next_turn");
      expect(yield* userTexts(session.id)).toEqual(["edited on server"]);
      expect(
        session
          .invocations()[0]
          ?.history.some(
            (message) => message.role === "user" && message.content === "edited on server",
          ),
      ).toBe(true);
      // The stored conversation keeps the queued message as the server sent it.
      const stored = page.view().messages;
      expect(stored.find((message) => message.role === "user")?.id).toBe(stale.id);
      expect(page.texts("user")).toEqual(["edited on server"]);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ChatMessage)))(stored),
      ).not.toContain("original");
    }),
  );

  it.effect("a failed queue settlement holds what was waiting until the user confirms it", () =>
    Effect.gen(function* () {
      const session = yield* chatSession;
      const agent = yield* agentChat;
      const runStore = yield* RunStore;
      // The page holds the session, so a settled finish would leave the message waiting for it.
      yield* agent.lease(session.id, "tab", "claim");
      const sending = yield* sendInBackground(yield* openPage(session.id, "tab"), "please be slow");
      yield* until(() => session.invocations().length === 1, "the answer to start");
      yield* enqueue(session.id, "and the tests", "queue", "tab");
      const runId = (yield* statusOf(session.id)).running!.runId;
      const original = runStore.run;
      const lookup = vi.spyOn(runStore, "run").mockImplementation((id) =>
        id === runId
          ? Effect.fail(
              SqlError.SqlError.make({
                reason: SqlError.classifySqliteError(new Error("store unavailable")),
              }),
            )
          : original(id),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => lookup.mockRestore()));
      yield* session.release;
      yield* Fiber.join(sending);
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
      const sending = yield* sendInBackground(yield* openPage(session.id), "please be slow");
      yield* until(() => session.invocations().length === 1, "the answer to start");
      yield* enqueue(session.id, "never mind", "queue");
      yield* agent.cancel(session.id, null);
      yield* Fiber.join(sending);
      expect(session.invocations()).toHaveLength(1);

      const [held] = (yield* queueOf(session.id)).items;
      expect(held?.state).toEqual(QueueItemState.held({ draft: null }));
      const confirmed = yield* agent.editQueued(session.id, null, held!.id, QueueEdit.confirm());
      expect(confirmed?.state).toEqual(QueueItemState.waiting({ steered: false }));
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
        const page = yield* openPage(session.id);
        const sending = yield* sendInBackground(page, message);
        switch (interrupted) {
          case "answer":
            yield* until(() => session.invocations().length === 1, "the run to be answering");
            break;
          case "approval":
            // Approval ends the run, so its stream ends with the approval it waits for.
            yield* Fiber.join(sending);
            expect(page.pending()).toHaveLength(1);
            break;
        }
        yield* Fiber.interrupt(sending);
        const asked = session.invocations().length;
        yield* env.reopen;
        expect(yield* statusOf(session.id)).toMatchObject({
          running: null,
          lastRun: { status: "failed", error: { code: "server_restarted" } },
        });
        // No run or approval is offered again, and the provider was not asked to start anything.
        const reloaded = yield* openPage(session.id);
        expect(reloaded.view().messages.length).toBeGreaterThan(0);
        expect(reloaded.opened.activeRun).toBeNull();
        expect(reloaded.pending()).toEqual([]);
        expect(session.invocations()).toHaveLength(asked);
      }),
  );
});
