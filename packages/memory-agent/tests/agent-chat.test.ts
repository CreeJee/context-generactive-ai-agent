import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { Database } from "../src/db/database.ts";
import { embeddedKindFilter, Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

function chatRequest(text: string) {
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-ui",
      runId: `run-${Math.random().toString(36).slice(2)}`,
      messages: [{ id: "m1", role: "user", content: text }],
      tools: [],
      context: [],
    }),
  });
}

const Count = Schema.Struct({ count: Schema.Finite });

describe("AgentChat.handle", () => {
  test("answers from memory through provider tools, records the run and indexes it", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, project, session } = context;
    await context.provider!.select(context.runtime);
    const earlier = await runtime.runPromise(
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
    );

    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(chatRequest("what did we decide? remember"), earlier.next.id),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const Delta = Schema.fromJsonString(
      Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
    );
    const answer = (await response.text())
      .split("\n")
      .flatMap((line) =>
        line.startsWith("data: ") ? [Schema.decodeSync(Delta)(line.slice(6))] : [],
      )
      .flatMap((event) =>
        event.type === "TEXT_MESSAGE_CONTENT" && event.delta ? [event.delta] : [],
      )
      .join("");
    expect(answer).toBe("Found: 저장소는 SQLite로 결정했다.");

    const nodes = await runtime.runPromise(Nodes);
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
    const db = await runtime.runPromise(Database);
    const unindexed = () =>
      Schema.decodeUnknownSync(Count)(
        db.sqlite
          .prepare(
            `SELECT count(*) AS count FROM nodes n LEFT JOIN node_vectors v ON v.node_seq = n.seq WHERE v.node_seq IS NULL AND length(n.text) > 0 AND ${embeddedKindFilter}`,
          )
          .get(),
      ).count;
    for (let attempt = 0; attempt < 50 && unindexed() > 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unindexed()).toBe(0);
  });

  test("hides Work Trace behind a reversible exposure flag without deleting shadow data", async () => {
    const context = await testRuntime();
    const { runtime, session } = context;
    const services = await runtime.runPromise(
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
    );

    await runtime.runPromise(services.config.update({ workTraceEnabled: false }));
    const hidden = await runtime.runPromise(services.agent.traceTree(session.id));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "work_trace_disabled" });
    expect(services.db.sqlite.prepare("SELECT count(*) AS count FROM work_tasks").get()).toEqual({
      count: 1,
    });

    await runtime.runPromise(services.config.update({ workTraceEnabled: true }));
    const visible = await runtime.runPromise(services.agent.traceTree(session.id));
    expect(visible.status).toBe(200);
    expect(JSON.stringify(await visible.json())).toContain(services.handle.taskId);
  });

  test("refuses to run without login, without a chosen model, or for an unknown session", async () => {
    const signedOut = await testRuntime({ testProvider: { signedIn: false } });
    const handle = (context: typeof signedOut, sessionId: string) =>
      context.runtime.runPromise(
        Effect.flatMap(AgentChat, (agent) => agent.handle(chatRequest("hi"), sessionId)),
      );
    expect((await handle(signedOut, signedOut.session.id)).status).toBe(401);

    const noModel = await testRuntime({ testProvider: {} });
    const missingModel = await handle(noModel, noModel.session.id);
    expect(missingModel.status).toBe(412);
    expect(await missingModel.json()).toEqual({ error: "model_selection_required" });

    await noModel.provider!.select(noModel.runtime);
    expect((await handle(noModel, "no-such-session")).status).toBe(404);

    const unavailable = await testRuntime({ providerRegistry: ProviderRegistry.layer([], []) });
    const unavailableResponse = await handle(unavailable, unavailable.session.id);
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({
      error: "provider_auth_unavailable",
      provider: "openai",
    });
  });
});
