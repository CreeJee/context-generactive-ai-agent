import { Deferred, Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";
import { turnGate } from "./support/provider.ts";

test("cancelled pending worker pull cannot leave a stopped SDK run marked running or completed", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  const gate = turnGate();
  const started = Effect.runSync(Deferred.make<void>());
  try {
    const context = await testRuntime({
      testProvider: {
        responder: async () => {
          Effect.runSync(Deferred.succeed(started, undefined));
          // Hold the external SDK callback itself, before its cooperative signal
          // handling: this deterministically keeps the admitted modelNext pending.
          await gate.waitFor;
          return { text: "must not publish after cancellation" };
        },
      },
    });
    await context.provider!.select(context.runtime);
    const { db, workflows, chat } = await context.runtime.runPromise(
      Effect.all({ db: Database, workflows: Workflows, chat: AgentChat }),
    );
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, {
        statement: "Keep cancellation outcome and uncertain effects without replay",
        outcomes: ["No false completed or running state after worker termination"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    const runId = "cancelled-pending-worker";
    const request = (id: string) =>
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: context.session.id,
          runId: id,
          messages: [{ id: "user-1", role: "user", content: "wait until cancelled" }],
          tools: [],
          context: [],
        }),
      });
    const response = await context.runtime.runPromise(
      chat.handle(request(runId), context.session.id),
    );
    expect(response.status).toBe(200);
    const delivered = response.text();
    await context.runtime.runPromise(Deferred.await(started));
    const cancel = await context.runtime.runPromise(chat.cancel(context.session.id, null));
    expect(cancel.status).toBe(200);
    const result = await cancel.json();
    expect(result).toMatchObject({ runId, stopped: true, status: "failed" });
    const output = await delivered;
    expect(output).not.toContain("must not publish after cancellation");
    expect((output.match(/"type":"RUN_ERROR"/g) ?? []).length).toBe(1);
    expect(output).toContain('"code":"worker_execution_failed"');
    expect(output).not.toContain("Worker cancellation outcome unacknowledged");
    const row = db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId);
    expect(row).toEqual({ status: "failed" });
    const receipts = db.sqlite
      .prepare(
        "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id",
      )
      .all(runId);
    expect(receipts.some((receipt) => receipt.status === "pending")).toBe(true);
    const offsets = [...output.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
    expect(offsets.length).toBeGreaterThan(1);
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
        .get(context.session.id),
    ).toEqual({ n: 1 });
    const calls = context.provider!.adapter.invocations.length;
    const reopened = await context.reopen();
    const owner = await reopened.runPromise(Effect.all({ db: Database, chat: AgentChat }));
    expect(
      owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
    ).toEqual(row);
    const replay = await reopened.runPromise(
      owner.chat.hydrate(
        new Request(`http://localhost/api/chat?runId=${runId}`, {
          headers: { "Last-Event-ID": offsets[0]! },
        }),
        context.session.id,
      ),
    );
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(output.slice(output.indexOf("\n\n") + 2));
    expect(
      owner.db.sqlite
        .prepare(
          "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id",
        )
        .all(runId),
    ).toEqual(receipts);
    for (const id of [runId, `${runId}-bypass`]) {
      const retry = await reopened.runPromise(owner.chat.handle(request(id), context.session.id));
      expect(retry.status).toBe(409);
    }
    expect(context.provider!.adapter.invocations.length).toBe(calls);
  } finally {
    gate.release();
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 20000);
