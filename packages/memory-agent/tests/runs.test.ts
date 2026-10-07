import { it } from "@effect/vitest";
import { waitUntil } from "./support/wait-until.ts";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { selectTestModel, turnGate } from "./support/provider.ts";
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

const sdkCall = Effect.fn("runsTest.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const until = (condition: () => boolean, what: string) => waitUntil(condition, what, 6000);

/** A browser tab: a TanStack client hydrating from and posting to AgentChat in-process. */
const openTab = Effect.fn("runsTest.openTab")(function* (runtime: Runtime, sessionId: string) {
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
  yield* Effect.addFinalizer(() => Effect.sync(() => client.dispose()));
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
});

const setup = Effect.fn("runsTest.setup")(function* () {
  const gate = turnGate();
  const context = yield* sdkCall(() =>
    testRuntime({ testProvider: { delayedTurnGate: gate.waitFor } }),
  );
  yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
  yield* Effect.addFinalizer(() => Effect.sync(gate.release));
  return { ...context, releaseDelayedTurn: gate.release };
});

const statusOf = Effect.fn("runsTest.statusOf")(function* (runtime: Runtime, sessionId: string) {
  const response = yield* Effect.provideContext(
    Effect.flatMap(AgentChat, (agent) => agent.status(sessionId, null)),
    yield* runtime.contextEffect,
  );
  return yield* Schema.decodeUnknownEffect(Status)(yield* sdkCall(() => response.json()));
});

describe("runs across reloads, cancels and restarts", () => {
  it.live("a reloaded page rejoins a durable app run without invoking the provider again", () =>
    Effect.gen(function* () {
      const { runtime, session, provider, releaseDelayedTurn } = yield* setup();
      const first = yield* openTab(runtime, session.id);
      yield* Effect.forkChild(
        sdkCall(() => first.client.sendMessage("please be slow")),
        { startImmediately: true },
      );
      yield* until(() => provider!.adapter.invocations.length === 1, "the provider run to start");
      // The tab reloads mid-answer.
      first.client.dispose();
      const second = yield* openTab(runtime, session.id);
      releaseDelayedTurn();
      yield* until(() => second.text().endsWith("done"), "the rest of the answer");
      expect(second.text()).toBe("done");
      yield* until(() => !second.client.getSessionGenerating(), "the rejoined run to settle");
      second.client.dispose();
      expect(provider!.adapter.invocations).toHaveLength(1);
      expect((yield* statusOf(runtime, session.id)).lastRun?.status).toBe("completed");
    }),
  );

  it.live("cancel stops the running run and reports that it really stopped", () =>
    Effect.gen(function* () {
      const { runtime, session, provider } = yield* setup();
      const tab = yield* openTab(runtime, session.id);
      yield* Effect.forkChild(
        sdkCall(() => tab.client.sendMessage("please be slow")),
        { startImmediately: true },
      );
      yield* until(() => provider!.adapter.invocations.length === 1, "the provider run to start");
      const running = yield* statusOf(runtime, session.id);
      expect(running.running).not.toBeNull();
      for (const decision of Object.values(running.actions.phases))
        expect(decision).toEqual({ allowed: false, reason: "run_in_progress" });
      expect(running.actions.controls.resume).toEqual({
        allowed: false,
        reason: "run_in_progress",
      });
      const refused = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.setWorkflowPhase(session.id, null, "plan")),
        yield* runtime.contextEffect,
      );
      expect(refused.status).toBe(409);
      expect(yield* sdkCall(() => refused.json())).toEqual({ error: "run_in_progress" });
      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
        yield* runtime.contextEffect,
      );
      const cancelled = yield* Schema.decodeUnknownEffect(Cancelled)(
        yield* sdkCall(() => response.json()),
      );
      expect(cancelled).toMatchObject({ stopped: true, status: "aborted" });
      expect(provider!.adapter.invocations).toHaveLength(1);
      expect(tab.text()).not.toContain("done");
      const status = yield* statusOf(runtime, session.id);
      expect(status.running).toBeNull();
      expect(status.lastRun?.status).toBe("aborted");
      // Nothing is running any more, so a second cancel has nothing to stop.
      const again = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
        yield* runtime.contextEffect,
      );
      expect(again.status).toBe(409);
      const seen = tab.text();
      tab.client.dispose();
      // A reload shows exactly the durable text saved before cancellation and does not rerun it.
      const reloaded = yield* openTab(runtime, session.id);
      yield* until(() => reloaded.client.getMessages().length > 0, "the stored transcript");
      expect(reloaded.text()).toBe(seen);
      expect(provider!.adapter.invocations).toHaveLength(1);
      reloaded.client.dispose();
    }),
  );

  it.live("cancel stops a running Plan-phase run without changing its workflow phase", () =>
    Effect.gen(function* () {
      const { runtime, session, provider } = yield* setup();
      const agent = yield* Effect.provideContext(AgentChat, yield* runtime.contextEffect);
      const phase = yield* Effect.provideContext(
        agent.setWorkflowPhase(session.id, null, "plan"),
        yield* runtime.contextEffect,
      );
      expect(phase.status).toBe(200);
      const tab = yield* openTab(runtime, session.id);
      yield* Effect.forkChild(
        sdkCall(() => tab.client.sendMessage("please be slow")),
        { startImmediately: true },
      );
      yield* until(() => provider!.adapter.invocations.length === 1, "the Plan run to start");
      const running = yield* statusOf(runtime, session.id);
      expect(running.running).not.toBeNull();
      expect(running.actions.phases.plan).toEqual({ allowed: false, reason: "run_in_progress" });
      const response = yield* Effect.provideContext(
        agent.cancel(session.id, null),
        yield* runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      expect(
        yield* Schema.decodeUnknownEffect(Cancelled)(yield* sdkCall(() => response.json())),
      ).toMatchObject({
        runId: running.running!.runId,
        stopped: true,
        status: "aborted",
      });
      const stopped = yield* statusOf(runtime, session.id);
      expect(stopped.running).toBeNull();
      expect(stopped.lastRun).toMatchObject({ runId: running.running!.runId, status: "aborted" });
      expect(stopped.actions.phases.plan).toEqual({ allowed: true });
      const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
      expect(
        (yield* Effect.provideContext(workflows.get(session.id), yield* runtime.contextEffect))
          .phase,
      ).toBe("plan");
      tab.client.dispose();
    }),
  );

  it.live("a second run in the same session is refused while the first is answering", () =>
    Effect.gen(function* () {
      const { runtime, session, provider } = yield* setup();
      const tab = yield* openTab(runtime, session.id);
      yield* Effect.forkChild(
        sdkCall(() => tab.client.sendMessage("please be slow")),
        { startImmediately: true },
      );
      yield* until(() => provider!.adapter.invocations.length === 1, "the first run to start");
      const response = yield* Effect.provideContext(
        Effect.flatMap(
          AgentChat,
          Effect.fnUntraced(function* (agent) {
            return yield* agent.handle(
              new Request(`http://127.0.0.1/api/chat?session=${session.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
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
            );
          }),
        ),
        yield* runtime.contextEffect,
      );
      expect(response.status).toBe(409);
      yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
        yield* runtime.contextEffect,
      );
      tab.client.dispose();
    }),
  );

  it.live("after a restart an unfinished run is marked failed, not resumed or rerun", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const tab = yield* openTab(context.runtime, context.session.id);
      yield* Effect.forkChild(
        sdkCall(() => tab.client.sendMessage("please be slow")),
        { startImmediately: true },
      );
      yield* until(
        () => context.provider!.adapter.invocations.length === 1,
        "the run to be answering",
      );
      tab.client.dispose();
      const restarted = yield* sdkCall(() => context.reopen());
      const status = yield* statusOf(restarted, context.session.id);
      expect(status.running).toBeNull();
      expect(status.lastRun).toMatchObject({
        status: "failed",
        error: { code: "server_restarted" },
      });
      // No run is offered for rejoining, and the provider was not asked to start anything again.
      const reloaded = yield* openTab(restarted, context.session.id);
      yield* until(() => reloaded.client.getMessages().length > 0, "the stored transcript");
      expect(reloaded.client.getSessionGenerating()).toBe(false);
      expect(context.provider!.adapter.invocations).toHaveLength(1);
      reloaded.client.dispose();
    }),
  );

  it.live("a restart retires an approval whose app-run continuation no longer exists", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const tab = yield* openTab(context.runtime, context.session.id);
      // Approval deliberately pauses the request, so wait for the interrupt rather than for the
      // send promise, which only settles after that interrupt has been answered.
      yield* Effect.forkChild(
        sdkCall(() => tab.client.sendMessage("please use the shell")),
        { startImmediately: true },
      );
      yield* until(() => tab.client.getInterrupts().length === 1, "the approval request");
      tab.client.dispose();
      const restarted = yield* sdkCall(() => context.reopen());
      const reloaded = yield* openTab(restarted, context.session.id);
      yield* until(() => reloaded.client.getMessages().length > 0, "the restored transcript");
      expect(reloaded.client.getInterrupts()).toEqual([]);
      expect(reloaded.client.getError()).toBeUndefined();
      expect(yield* statusOf(restarted, context.session.id)).toMatchObject({
        running: null,
        lastRun: { status: "failed", error: { code: "server_restarted" } },
      });
      reloaded.client.dispose();
    }),
  );
});
