import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { optionalProperty } from "../src/optional-property.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";
import { turnGate } from "./support/provider.ts";

const goal = {
  statement: "Keep failed worker output without replay",
  outcomes: ["One admission and preserved committed evidence"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const request = (sessionId: string, runId: string) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: sessionId,
      runId,
      messages: [{ id: "user-1", role: "user", content: "stream then fail" }],
      tools: [],
      context: [],
    }),
  });

for (const toolFirst of [false, true]) {
  test(`real worker midstream failure preserves durable output and denies replay${toolFirst ? " after a tool" : ""}`, async () => {
    const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
    process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
    const gate = turnGate();
    let notifyModelStarted = () => {};
    const modelStarted = new Promise<void>((resolve) => {
      notifyModelStarted = resolve;
    });
    const partial = "Committed partial output before deterministic failure";
    try {
      let turn = 0;
      const context = await testRuntime({
        testProvider: {
          responder: () => {
            notifyModelStarted();
            const index = turn++;
            if (toolFirst && index === 0)
              return {
                waitFor: gate.waitFor,
                toolCalls: [
                  {
                    id: "read-before-failure",
                    name: "find_memory",
                    arguments: JSON.stringify({ query: "absent deterministic memory" }),
                  },
                ],
              };
            return {
              text: partial,
              failAfterText: "deterministic-provider-midstream-failure",
              ...optionalProperty("waitFor", toolFirst ? undefined : gate.waitFor),
            };
          },
        },
      });
      await context.provider!.select(context.runtime);
      const { db, workflows, chat } = await context.runtime.runPromise(
        Effect.all({ db: Database, workflows: Workflows, chat: AgentChat }),
      );
      await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal));
      const runId = toolFirst ? "failed-worker-with-tool" : "failed-worker";
      const response = await context.runtime.runPromise(
        chat.handle(request(context.session.id, runId), context.session.id),
      );
      expect(response.status).toBe(200);
      const deliveredPromise = response.text();
      await modelStarted;
      const userCount = () =>
        db.sqlite
          .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
          .get(context.session.id);
      expect(userCount()).toEqual({ n: 1 });
      for (const duplicateId of [runId, `${runId}-bypass`]) {
        const duplicate = await context.runtime.runPromise(
          chat.handle(request(context.session.id, duplicateId), context.session.id),
        );
        expect(duplicate.status).toBe(409);
        expect(userCount()).toEqual({ n: 1 });
      }
      gate.release();
      const delivered = await deliveredPromise;
      expect.soft(delivered).toContain(partial);
      expect.soft(delivered).toContain("RUN_ERROR");
      expect((delivered.match(/"type":"RUN_ERROR"/g) ?? []).length).toBe(1);
      expect(delivered).toContain('"code":"worker_execution_failed"');
      expect(delivered).not.toContain("deterministic-provider-midstream-failure");
      expect(delivered).not.toContain("Inactive owner chunk capability");
      expect(db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId)).toEqual(
        { status: "failed" },
      );
      const offsets = [...delivered.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
      expect(offsets.length).toBeGreaterThan(1);
      expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:"))).toBe(true);
      const callsBeforeRestart = context.provider!.adapter.invocations.length;
      const effects = db.sqlite
        .prepare(
          "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? AND json_extract(fingerprint, '$.operation') = 'tool' ORDER BY operation_id",
        )
        .all(runId);
      expect(effects.length).toBe(toolFirst ? 1 : 0);
      if (toolFirst) expect(effects[0]!.status).toBe("succeeded");
      const reopened = await context.reopen();
      const owner = await reopened.runPromise(Effect.all({ db: Database, chat: AgentChat }));
      expect(
        owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
      ).toEqual({ status: "failed" });
      const replay = await reopened.runPromise(
        owner.chat.hydrate(
          new Request(`http://localhost/api/chat?runId=${runId}`, {
            headers: { "Last-Event-ID": offsets[0]! },
          }),
          context.session.id,
        ),
      );
      expect(replay.status).toBe(200);
      expect.soft(await replay.text()).toBe(delivered.slice(delivered.indexOf("\n\n") + 2));
      for (const retryId of [runId, `${runId}-after-reopen`]) {
        const retry = await reopened.runPromise(
          owner.chat.handle(request(context.session.id, retryId), context.session.id),
        );
        expect(retry.status).toBe(409);
      }
      expect(context.provider!.adapter.invocations.length).toBe(callsBeforeRestart);
      expect(
        owner.db.sqlite
          .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
          .get(context.session.id),
      ).toEqual({ n: 1 });
      expect(
        owner.db.sqlite
          .prepare(
            "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? AND json_extract(fingerprint, '$.operation') = 'tool' ORDER BY operation_id",
          )
          .all(runId),
      ).toEqual(effects);
      expect(
        owner.db.sqlite
          .prepare("SELECT count(*) AS n FROM workflow_run_bindings WHERE session_id = ?")
          .get(context.session.id),
      ).toEqual({ n: 1 });
    } finally {
      gate.release();
      if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
      else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
    }
  });
}
