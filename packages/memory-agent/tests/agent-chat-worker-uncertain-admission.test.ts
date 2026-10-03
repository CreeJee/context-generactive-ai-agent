import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import { Database } from "../src/db/database.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

test.each(["pending", "uncertain", "succeeded"] as const)(
  "completed SDK run with %s side effect respects actual AgentChat admission",
  async (status) => {
    const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
    process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
    try {
      const context = await testRuntime({ testProvider: {} });
      await context.provider!.select(context.runtime);
      const { chat, db, workflows } = await context.runtime.runPromise(
        Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
      );
      await context.runtime.runPromise(
        workflows.updateGoal(context.session.id, {
          statement: "Never replay an uncertain effect",
          outcomes: ["Owner receipts fence admission"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
      const revision = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
        db.sqlite
          .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
          .get(context.session.id),
      ).id;
      const admission = workflowRunBindings(db).bind(context.session.id, "oldrun", revision);
      if (admission.status !== "bound") throw new Error("expected old binding");
      db.sqlite
        .prepare(
          "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', ?)",
        )
        .run("oldrun", context.session.id, Date.now());
      const ledger = makeSqliteOwnerRpcLedger(db);
      const key = JSON.stringify(admission.binding);
      expect(ledger.reserve(key, 1, "old-effect", true)).toEqual({ type: "reserved" });
      switch (status) {
        case "pending":
          break;
        case "uncertain":
          ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
          break;
        case "succeeded":
          ledger.settle(key, 1, { type: "succeeded", operationId: 1, output: null });
          break;
      }
      const tables = [
        "workflow_run_bindings",
        "workflow_worker_dispatches",
        "workflow_run_events",
        "owner_rpc_operations",
        "chat_runs",
        "nodes",
      ];
      const before = tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all());
      const response = await context.runtime.runPromise(
        chat.handle(
          new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: context.session.id,
              runId: "newrun",
              messages: [{ id: "m1", role: "user", content: "hello" }],
              tools: [],
              context: [],
            }),
          }),
          context.session.id,
        ),
      );
      // Consume even a failing baseline's stream so model invocation is observable.
      const body = await response.text();
      if (status === "succeeded") {
        expect(response.status).toBe(200);
        expect(context.provider!.adapter.invocations.length).toBeGreaterThan(0);
        expect(db.sqlite.prepare("SELECT count(*) AS n FROM workflow_run_bindings").get()).toEqual({
          n: 2,
        });
        expect(
          db.sqlite.prepare("SELECT * FROM owner_rpc_operations WHERE run_id = 'oldrun'").all(),
        ).toEqual(before[3]);
        return;
      }
      expect({
        status: response.status,
        invocations: context.provider!.adapter.invocations.length,
        bindings: db.sqlite.prepare("SELECT count(*) AS n FROM workflow_run_bindings").get(),
        body: response.status === 409 ? JSON.parse(body) : "stream",
      }).toMatchObject({ status: 409, invocations: 0, bindings: { n: 1 } });
      expect(tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(
        before,
      );
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
      else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
    }
  },
);
