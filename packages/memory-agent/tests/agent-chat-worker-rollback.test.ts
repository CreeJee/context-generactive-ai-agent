import { Effect, Schema } from "effect";

import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const History = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });

const goal = {
  statement: "Roll back worker execution without losing central evidence",
  outcomes: ["Completed turns remain queryable; uncertain turns never retry"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const request = (sessionId: string, runId: string) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Run-Id": runId },
    body: JSON.stringify({
      threadId: sessionId,
      runId,
      messages: [{ id: `user-${runId}`, role: "user", content: `hello ${runId}` }],
      tools: [],
      context: [],
    }),
  });
const offsets = (stream: string) => [...stream.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
const restore = (previous: string | undefined) => {
  if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
  else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
};

// Each test owns its env change, restores it even on failure, and never runs concurrently.
describe("real AgentChat worker opt-in rollback", { concurrent: false }, () => {
  test("completed worker evidence survives rollback, a legacy turn and owner reopen", async () => {
    const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
    process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
    try {
      const context = await testRuntime({
        testProvider: { responder: () => ({ text: "durable answer" }) },
      });
      await context.provider!.select(context.runtime);
      const owner = await context.runtime.runPromise(
        Effect.all({ db: Database, chat: AgentChat, workflows: Workflows }),
      );
      await context.runtime.runPromise(owner.workflows.updateGoal(context.session.id, goal));
      const workerRun = "rollback-completed-worker";
      const response = await context.runtime.runPromise(
        owner.chat.handle(request(context.session.id, workerRun), context.session.id),
      );
      expect(response.status).toBe(200);
      const delivered = await response.text();
      expect(delivered).toContain("durable answer");
      expect(delivered).not.toContain("RUN_ERROR");
      expect(
        owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(workerRun),
      ).toEqual({ status: "completed" });
      expect(
        owner.db.sqlite
          .prepare("SELECT count(*) AS n FROM workflow_worker_dispatches WHERE run_id = ?")
          .get(workerRun),
      ).toEqual({ n: 1 });
      const cursor = offsets(delivered)[0]!;
      expect(cursor).toMatch(/^sdk-stream:v1:/);
      const initialNodes = owner.db.sqlite
        .prepare("SELECT seq FROM nodes WHERE session_id = ? ORDER BY seq")
        .all(context.session.id);
      expect(initialNodes).toHaveLength(2);
      const lastSeq = initialNodes.at(-1)!.seq;
      // Compare serialized rows, including timestamps/payload JSON, not merely counts/status.
      const snapshot = (db: Database["Service"]) =>
        JSON.stringify({
          run: db.sqlite.prepare("SELECT * FROM chat_runs WHERE run_id = ?").all(workerRun),
          binding: db.sqlite
            .prepare("SELECT * FROM workflow_run_bindings WHERE run_id = ?")
            .all(workerRun),
          dispatch: db.sqlite
            .prepare("SELECT * FROM workflow_worker_dispatches WHERE run_id = ?")
            .all(workerRun),
          events: db.sqlite
            .prepare("SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY cursor")
            .all(workerRun),
          operations: db.sqlite
            .prepare("SELECT * FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id")
            .all(workerRun),
          transcript: db.sqlite
            .prepare("SELECT * FROM nodes WHERE session_id = ? AND seq <= ? ORDER BY seq")
            .all(context.session.id, lastSeq!),
        });
      const before = snapshot(owner.db);
      const historyRequest = () =>
        new Request(`http://localhost/api/chat?threadId=${context.session.id}`);
      const initialHistory = Schema.decodeUnknownSync(History)(
        await (
          await context.runtime.runPromise(owner.chat.hydrate(historyRequest(), context.session.id))
        ).json(),
      );
      const storedTranscript = JSON.stringify(
        owner.db.sqlite
          .prepare("SELECT * FROM chat_threads WHERE thread_id = ?")
          .get(context.session.id),
      );
      const repeatedHistory = Schema.decodeUnknownSync(History)(
        await (
          await context.runtime.runPromise(owner.chat.hydrate(historyRequest(), context.session.id))
        ).json(),
      );
      expect(JSON.stringify(repeatedHistory.messages)).toBe(
        JSON.stringify(initialHistory.messages),
      );
      const newestPage = Schema.decodeUnknownSync(History)(
        await (
          await context.runtime.runPromise(
            owner.chat.hydrate(new Request(`${historyRequest().url}&limit=1`), context.session.id),
          )
        ).json(),
      );
      expect(newestPage.messages).toEqual(initialHistory.messages.slice(-1));
      expect(
        JSON.stringify(
          owner.db.sqlite
            .prepare("SELECT * FROM chat_threads WHERE thread_id = ?")
            .get(context.session.id),
        ),
      ).toBe(storedTranscript);
      process.env.CONTEXT_AGENT_GOAL_WORKER = "0";
      const legacyRun = "rollback-new-legacy";
      const legacy = await context.runtime.runPromise(
        owner.chat.handle(request(context.session.id, legacyRun), context.session.id),
      );
      expect(legacy.status).toBe(200);
      const legacyStream = await legacy.text();
      expect(legacyStream).toContain("durable answer");
      expect(legacyStream).not.toContain("RUN_ERROR");
      expect(
        owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(legacyRun),
      ).toEqual({ status: "completed" });
      for (const table of [
        "workflow_run_bindings",
        "workflow_worker_dispatches",
        "workflow_run_events",
        "owner_rpc_operations",
      ])
        expect(
          owner.db.sqlite
            .prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?`)
            .get(legacyRun),
        ).toEqual({ n: 0 });
      expect(context.provider!.adapter.invocations).toHaveLength(2);
      expect(snapshot(owner.db)).toBe(before);
      const legacyCursor = offsets(legacyStream)[0]!;
      expect(legacyCursor).toMatch(new RegExp(`^memory:v1:${legacyRun}:`));
      const join = (runId: string, offset: string) =>
        new Request(`http://localhost/api/chat?runId=${runId}`, {
          headers: { "Last-Event-ID": offset },
        });
      const legacyReplay = await context.runtime.runPromise(
        owner.chat.hydrate(join(legacyRun, legacyCursor), context.session.id),
      );
      expect(legacyReplay.status).toBe(200);
      expect(await legacyReplay.text()).toBe(legacyStream.slice(legacyStream.indexOf("\n\n") + 2));
      for (const [runId, offset] of [
        [legacyRun, cursor],
        [workerRun, legacyCursor],
      ]) {
        const wrong = await context.runtime.runPromise(
          owner.chat.hydrate(join(runId!, offset!), context.session.id),
        );
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toEqual({ error: "invalid_stream_offset" });
      }
      const reopened = await context.reopen();
      const after = await reopened.runPromise(Effect.all({ db: Database, chat: AgentChat }));
      expect(snapshot(after.db)).toBe(before);
      const replay = await reopened.runPromise(
        after.chat.hydrate(join(workerRun, cursor), context.session.id),
      );
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(delivered.slice(delivered.indexOf("\n\n") + 2));
      const history = Schema.decodeUnknownSync(History)(
        await (
          await reopened.runPromise(after.chat.hydrate(historyRequest(), context.session.id))
        ).json(),
      );
      // Hydration may add the later turn, but the former turn's messages must be unchanged.
      expect(history.messages.slice(0, initialHistory.messages.length)).toEqual(
        initialHistory.messages,
      );
      expect(history.messages).toHaveLength(4);
      expect(context.provider!.adapter.invocations).toHaveLength(2);
    } finally {
      restore(previous);
    }
  });

  test("opt-in off cannot retry or bypass an uncertain worker outcome after reopen", async () => {
    const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
    process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
    try {
      const context = await testRuntime({
        testProvider: {
          responder: () => ({
            text: "committed partial",
            failAfterText: "deterministic rollback failure",
          }),
        },
      });
      await context.provider!.select(context.runtime);
      const owner = await context.runtime.runPromise(
        Effect.all({ db: Database, chat: AgentChat, workflows: Workflows }),
      );
      await context.runtime.runPromise(owner.workflows.updateGoal(context.session.id, goal));
      const runId = "rollback-uncertain-worker";
      const response = await context.runtime.runPromise(
        owner.chat.handle(request(context.session.id, runId), context.session.id),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("RUN_ERROR");
      expect(
        owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
      ).toEqual({ status: "failed" });
      const receipts = JSON.stringify(
        owner.db.sqlite
          .prepare("SELECT * FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id")
          .all(runId),
      );
      process.env.CONTEXT_AGENT_GOAL_WORKER = "0";
      for (const restart of [false, true]) {
        const runtime = restart ? await context.reopen() : context.runtime;
        const current = await runtime.runPromise(Effect.all({ chat: AgentChat, db: Database }));
        for (const id of [runId, "rollback-uncertain-new-id"]) {
          const retry = await runtime.runPromise(
            current.chat.handle(request(context.session.id, id), context.session.id),
          );
          expect(retry.status).toBe(409);
          expect(await retry.json()).toEqual({ error: "run_outcome_uncertain" });
        }
        expect(
          JSON.stringify(
            current.db.sqlite
              .prepare("SELECT * FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id")
              .all(runId),
          ),
        ).toBe(receipts);
        expect(
          current.db.sqlite
            .prepare("SELECT count(*) AS n FROM chat_runs WHERE thread_id = ?")
            .get(context.session.id),
        ).toEqual({ n: 1 });
        expect(
          current.db.sqlite
            .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
            .get(context.session.id),
        ).toEqual({ n: 1 });
      }
      expect(context.provider!.adapter.invocations).toHaveLength(1);
    } finally {
      restore(previous);
    }
  });
});
