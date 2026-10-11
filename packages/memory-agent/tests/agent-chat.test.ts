import { isTruthy } from "../src/truthy.ts";
import { Cause, Option, Random, Schedule, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { Database } from "../src/db/database.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

const chatRequest = Effect.fn("agentChat.chatRequest")(function* (text: string) {
  const runId = `run-${(yield* Random.next).toString(36).slice(2)}`;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    threadId: "thread-ui",
    runId,
    messages: [{ id: "m1", role: "user", content: text }],
    tools: [],
    context: [],
  });
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
});

describe("AgentChat.handle", () => {
  it.live("rejects empty user text before creating evidence or a run", () =>
    Effect.gen(function* () {
      const context = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: {} }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) =>
          Effect.flatMap(chatRequest(""), (request) => agent.handle(request, context.session.id)),
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(400);
      expect(
        yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toEqual({ error: "empty_message" });
      const counts = yield* Effect.provideContext(
        Effect.map(Database, ({ sqlite }) => ({
          runs: sqlite.prepare("SELECT count(*) AS count FROM chat_runs").get()?.count,
          users: sqlite.prepare("SELECT count(*) AS count FROM nodes WHERE kind = 'user'").get()
            ?.count,
        })),
        yield* context.runtime.contextEffect,
      );
      expect(counts).toEqual({ runs: 0, users: 0 });
    }),
  );
  it.live("releases a pinned account only after the durable SSE stream finishes", () =>
    Effect.gen(function* () {
      const context = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: {} }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      let released = 0;
      Object.assign(context.provider!.adapter, {
        releaseRun: () => {
          released++;
        },
      });
      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) =>
          Effect.flatMap(chatRequest("hello"), (request) =>
            agent.handle(request, context.session.id),
          ),
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(released).toBe(1);
    }),
  );

  it.live("releases a pinned account on early model mismatch before streaming", () =>
    Effect.gen(function* () {
      const context = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: {} }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      yield* Effect.provideContext(
        Effect.flatMap(GlobalConfig, (config) =>
          config.update({
            provider: "openai",
            model: "not-in-new-account",
            reasoningEffort: "low",
          }),
        ),
        yield* context.runtime.contextEffect,
      );
      let released = 0;
      Object.assign(context.provider!.adapter, {
        releaseRun: () => {
          released++;
        },
      });
      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) =>
          Effect.flatMap(chatRequest("hello"), (request) =>
            agent.handle(request, context.session.id),
          ),
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(409);
      expect(
        yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toMatchObject({ error: "model_unavailable_for_account" });
      expect(released).toBe(1);
    }),
  );

  it.live("answers from memory through provider tools, records the run and indexes it", () =>
    Effect.gen(function* () {
      const context = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: {} }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const { runtime, project, session } = context;
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const earlier = yield* Effect.provideContext(
        Effect.gen(function* () {
          const node = (yield* Nodes).append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "저장소는 SQLite로 결정했다.",
          });
          yield* (yield* Indexer).indexAll();
          const next = yield* (yield* Sessions).create(project.id);
          return { node, next };
        }),
        yield* runtime.contextEffect,
      );

      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) =>
          Effect.flatMap(chatRequest("what did we decide? remember"), (request) =>
            agent.handle(request, earlier.next.id),
          ),
        ),
        yield* runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      const Delta = Schema.fromJsonString(
        Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
      );
      const events = yield* Effect.forEach(
        (yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => new Cause.UnknownError(cause),
        }))
          .split("\n")
          .filter((line) => line.startsWith("data: ")),
        (line) => Schema.decodeEffect(Delta)(line.slice(6)),
      );
      const answer = events
        .flatMap((event) =>
          event.type === "TEXT_MESSAGE_CONTENT" && isTruthy(event.delta) ? [event.delta] : [],
        )
        .join("");
      expect(answer).toBe("Found: 저장소는 SQLite로 결정했다.");

      const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
      expect(nodes.session(earlier.next.id).map((node) => node.kind)).toEqual([
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      const toolResult = nodes.session(earlier.next.id)[3]!;
      expect(toolResult.text).toContain(earlier.node.id);

      // Indexing runs in the background after the run; wait for it to catch up.
      const indexer = yield* Effect.provideContext(Indexer, yield* runtime.contextEffect);
      const indexed = yield* indexer.pending.pipe(
        Effect.repeat({ until: (remaining) => remaining === 0, schedule: Schedule.spaced(20) }),
        Effect.timeoutOption(1_000),
      );
      expect(Option.isSome(indexed)).toBe(true);
    }),
  );

  it.live("hides Work Trace behind a reversible exposure flag without deleting shadow data", () =>
    Effect.gen(function* () {
      const context = yield* Effect.tryPromise({
        try: () => testRuntime(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const { runtime, session } = context;
      const services = yield* Effect.provideContext(
        Effect.gen(function* () {
          const db = yield* Database;
          db.sqlite
            .prepare(`INSERT INTO subagents
            (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
            VALUES ('flag-agent', ?, 'flag-agent', 'test', 'running', 'parent-flag', 'test', 1, 1)`)
            .run(session.id);
          const trace = yield* WorkTraceStore;
          const handle = trace.startAttempt({
            sessionId: session.id,
            parentRunId: "parent-flag",
            parentToolCallId: "call-flag",
            agentId: "flag-agent",
            title: "Shadow trace",
            request: "Keep collecting while hidden",
            kind: "start",
            threadId: "subagent-flag-agent",
          });
          return { agent: yield* AgentChat, config: yield* GlobalConfig, db, handle };
        }),
        yield* runtime.contextEffect,
      );

      yield* Effect.provideContext(
        services.config.update({ workTraceEnabled: false }),
        yield* runtime.contextEffect,
      );
      const hidden = yield* Effect.provideContext(
        services.agent.traceTree(session.id),
        yield* runtime.contextEffect,
      );
      expect(hidden.status).toBe(404);
      expect(
        yield* Effect.tryPromise({
          try: () => hidden.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toEqual({ error: "work_trace_disabled" });
      expect(services.db.sqlite.prepare("SELECT count(*) AS count FROM work_tasks").get()).toEqual({
        count: 1,
      });

      yield* Effect.provideContext(
        services.config.update({ workTraceEnabled: true }),
        yield* runtime.contextEffect,
      );
      const visible = yield* Effect.provideContext(
        services.agent.traceTree(session.id),
        yield* runtime.contextEffect,
      );
      expect(visible.status).toBe(200);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Effect.tryPromise({
            try: () => visible.json(),
            catch: (cause) => new Cause.UnknownError(cause),
          }),
        ),
      ).toContain(services.handle.taskId);
    }),
  );

  it.live("refuses to run without login, without a chosen model, or for an unknown session", () =>
    Effect.gen(function* () {
      const signedOut = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: { signedIn: false } }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const handle = Effect.fnUntraced(function* (context: typeof signedOut, sessionId: string) {
        return yield* Effect.provideContext(
          Effect.flatMap(AgentChat, (agent) =>
            Effect.flatMap(chatRequest("hi"), (request) => agent.handle(request, sessionId)),
          ),
          yield* context.runtime.contextEffect,
        );
      });
      expect((yield* handle(signedOut, signedOut.session.id)).status).toBe(401);

      const noModel = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: {} }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const missingModel = yield* handle(noModel, noModel.session.id);
      expect(missingModel.status).toBe(412);
      expect(
        yield* Effect.tryPromise({
          try: () => missingModel.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toEqual({ error: "model_selection_required" });

      yield* Effect.provideContext(selectTestModel(), yield* noModel.runtime.contextEffect);
      expect((yield* handle(noModel, "no-such-session")).status).toBe(404);

      const unavailable = yield* Effect.tryPromise({
        try: () => testRuntime({ providerRegistry: ProviderRegistry.layer([], []) }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const unavailableResponse = yield* handle(unavailable, unavailable.session.id);
      expect(unavailableResponse.status).toBe(503);
      expect(
        yield* Effect.tryPromise({
          try: () => unavailableResponse.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toEqual({
        error: "provider_auth_unavailable",
        provider: "openai",
      });
    }),
  );
});
