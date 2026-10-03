import { Effect, Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { decodeFullLoopValue } from "../src/agent/full-loop-codec.ts";
import * as workerPreflight from "../src/agent/full-loop-preflight.ts";

test.each([false, true])(
  "opt-in AgentChat full worker finalizer failure=%s",
  async (failFinalizer) => {
    const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
    process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
    try {
      const context = await testRuntime({ testProvider: {} });
      await context.provider!.select(context.runtime);
      const { db, workflows, chat, state } = await context.runtime.runPromise(
        Effect.all({ db: Database, workflows: Workflows, chat: AgentChat, state: ChatState }),
      );
      const failingCleanup = vi.fn(() => {
        throw new Error("injected owner finalizer failure");
      });
      if (failFinalizer) {
        const original = state.middleware.bind(state);
        vi.spyOn(state, "middleware").mockImplementation(() => [
          ...original(),
          { name: "memory-agent/partial-answer", onFinish: failingCleanup },
        ]);
      }
      let middlewareNames: readonly string[] = [];
      const preflight = workerPreflight.preflightFullLoopExecution;
      vi.spyOn(workerPreflight, "preflightFullLoopExecution").mockImplementation(
        (turn, capabilities) => {
          middlewareNames = capabilities.middleware.map((middleware) => middleware.name ?? "");
          return preflight(turn, capabilities);
        },
      );
      await context.runtime.runPromise(
        workflows.updateGoal(context.session.id, {
          statement: "Run safely in worker",
          outcomes: ["One durable turn"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
      const request = (runId: string) =>
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId,
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        });
      const response = await context.runtime.runPromise(
        chat.handle(request("worker-real"), context.session.id),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Hello from fast-1");
      if (failFinalizer) {
        expect(failingCleanup).toHaveBeenCalledTimes(1);
        expect(body.match(/"type":"RUN_ERROR"/g)).toHaveLength(1);
        expect(body).not.toContain("injected owner finalizer failure");
      } else {
        expect(body).not.toContain("RUN_ERROR");
        // The ledger persists canonical {operation,input} in fingerprint, not input_json.
        const receipts = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ fingerprint: Schema.String, status: Schema.String })),
        )(
          db.sqlite
            .prepare("SELECT fingerprint, status FROM owner_rpc_operations WHERE run_id = ?")
            .all("worker-real"),
        );
        const completedHooks = receipts.flatMap((receipt) => {
          const frame = Schema.decodeSync(
            Schema.fromJsonString(Schema.Struct({ operation: Schema.String, input: Schema.Json })),
          )(receipt.fingerprint);
          if (frame.operation !== "middleware") return [];
          const input = Schema.decodeUnknownSync(
            Schema.Struct({ index: Schema.Finite, hook: Schema.String }),
          )(decodeFullLoopValue(frame.input));
          return [{ name: middlewareNames[input.index], hook: input.hook, status: receipt.status }];
        });
        for (const name of [
          "memory-agent/queue-delivery",
          "memory-agent/subagents",
          "memory-agent/promoted-memory-use",
        ]) {
          expect(
            completedHooks.filter((entry) => entry.name === name && entry.hook === "onFinish"),
          ).toEqual([{ name, hook: "onFinish", status: "succeeded" }]);
        }
      }
      expect(
        db.sqlite
          .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'assistant'")
          .get(context.session.id),
      ).toEqual({ n: failFinalizer ? 0 : 1 });
      expect(
        db.sqlite
          .prepare(
            "SELECT count(*) AS n FROM owner_rpc_operations WHERE run_id = 'worker-real' AND status = 'pending'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = 'worker-real'").get(),
      ).toEqual({ status: failFinalizer ? "failed" : "completed" });
      expect(
        db.sqlite
          .prepare("SELECT count(*) AS n FROM workflow_run_bindings WHERE run_id = 'worker-real'")
          .get(),
      ).toEqual({ n: 1 });
      expect(
        db.sqlite
          .prepare(
            "SELECT count(*) AS n FROM workflow_worker_dispatches WHERE run_id = 'worker-real'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(
        Number(
          db.sqlite
            .prepare("SELECT count(*) AS n FROM owner_rpc_operations WHERE run_id = 'worker-real'")
            .get()!.n,
        ),
      ).toBeGreaterThan(0);
      const duplicate = await context.runtime.runPromise(
        chat.handle(request("worker-real"), context.session.id),
      );
      expect(duplicate.status).toBe(409);
      expect(
        db.sqlite
          .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
          .get(context.session.id),
      ).toEqual({ n: 1 });
    } finally {
      vi.restoreAllMocks();
      if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
      else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
    }
  },
);
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../src/workflow/run-events.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

test("unsupported opt-in worker preflight creates neither binding nor user node", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  try {
    const context = await testRuntime({ testProvider: {} });
    await context.provider!.select(context.runtime);
    const { db, workflows, chat, state } = await context.runtime.runPromise(
      Effect.all({ db: Database, workflows: Workflows, chat: AgentChat, state: ChatState }),
    );
    const original = state.middleware.bind(state);
    vi.spyOn(state, "middleware").mockImplementation(() => [
      ...original(),
      { name: "unsupported-preflight", unsupportedMember: true },
    ]);
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, {
        statement: "Preflight first",
        outcomes: ["No abandoned admission"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    const response = await context.runtime.runPromise(
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId: "unsupported-preflight",
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "unsupported_worker_capabilities",
      detail: "Unsupported worker middleware member: unsupportedMember",
    });
    vi.restoreAllMocks();
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM workflow_run_bindings WHERE session_id = ?")
        .get(context.session.id),
    ).toEqual({ n: 0 });
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
        .get(context.session.id),
    ).toEqual({ n: 0 });
  } finally {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
});

test("unbound Goal turns retain the usable legacy in-process fallback", async () => {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, {
      statement: "Require atomic acceptance",
      outcomes: ["No partial admission"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
  );
  for (const runId of ["automatic", "another-automatic"]) {
    const response = await context.runtime.runPromise(
      Effect.flatMap(AgentChat, (chat) =>
        chat.handle(
          new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: context.session.id,
              runId,
              messages: [{ id: "m1", role: "user", content: "hello" }],
              tools: [],
              context: [],
            }),
          }),
          context.session.id,
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello from fast-1");
    expect(db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId)).toEqual({
      status: "completed",
    });
  }
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
      .get(context.session.id),
  ).toEqual({ n: 2 });
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM workflow_run_bindings WHERE session_id = ?")
      .get(context.session.id),
  ).toEqual({ n: 0 });
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM chat_runs WHERE thread_id = ?")
      .get(context.session.id),
  ).toEqual({ n: 2 });
});

/** An owner-prepared run binding + a real AgentChat turn. This is NOT automatic admission. */
test("a real AgentChat turn keeps the owner-bound Goal version after the owner reopens", async () => {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, {
      statement: "Keep an ongoing Goal safe",
      outcomes: ["One recorded turn"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
  );
  const revision = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare(
        "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  const runId = "test-bound-real-agent-run";
  const admitted = workflowRunBindings(db).bind(context.session.id, runId, revision.id);
  expect(admitted.status).toBe("bound");
  const response = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId,
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    ),
  );
  expect(response.status).toBe(200);
  const delivered = await response.text();
  expect(delivered).toContain("Hello from fast-1");
  const offsets = [...delivered.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
  expect(offsets.length).toBeGreaterThan(1);
  expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:"))).toBe(true);
  const firstOffset = offsets[0]!;
  const replayExpected = delivered.slice(delivered.indexOf("\n\n") + 2);
  const reopened = await context.reopen();
  const replay = await reopened.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.hydrate(
        new Request(`http://localhost/api/chat?runId=${runId}`, {
          headers: { "Last-Event-ID": firstOffset },
        }),
        context.session.id,
      ),
    ),
  );
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(replayExpected);
  for (const badOffset of [
    "memory:v1:wrong:1",
    "sdk-stream:v1:wrong:1",
    `sdk-stream:v1:${runId}:99999999`,
    "now",
  ]) {
    const denied = await reopened.runPromise(
      Effect.flatMap(AgentChat, (chat) =>
        chat.hydrate(
          new Request(`http://localhost/api/chat?runId=${runId}`, {
            headers: { "Last-Event-ID": badOffset },
          }),
          context.session.id,
        ),
      ),
    );
    expect(denied.status).toBe(400);
  }
  const other = await reopened.runPromise(
    Effect.flatMap(Sessions, (sessions) => sessions.create(context.project.id)),
  );
  const wrongSession = await reopened.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.hydrate(
        new Request(`http://localhost/api/chat?runId=${runId}`, {
          headers: { "Last-Event-ID": firstOffset },
        }),
        other.id,
      ),
    ),
  );
  expect(wrongSession.status).toBe(404);
  const persisted = await reopened.runPromise(Database);
  const run = persisted.sqlite
    .prepare("SELECT thread_id, status FROM chat_runs WHERE run_id = ?")
    .get(runId);
  expect(run).toMatchObject({ thread_id: context.session.id, status: "completed" });
  const receipts = workflowRunEvents(persisted).replay(context.session.id, runId);
  expect(receipts.length).toBeGreaterThan(0);
  expect(JSON.stringify(receipts.map((event) => event.payload))).toContain("Hello from fast-1");
  expect(
    workflowRunEvents(persisted).replay(context.session.id, runId, receipts[0]!.cursor),
  ).toEqual(receipts.slice(1));
  expect(
    persisted.sqlite
      .prepare(
        "SELECT session_id, goal_instance_id, goal_version, workflow_revision_id FROM workflow_run_bindings WHERE run_id = ?",
      )
      .get(runId),
  ).toMatchObject({
    session_id: context.session.id,
    goal_instance_id: admitted.status === "bound" ? admitted.binding.goalInstanceId : "",
    goal_version: 1,
    workflow_revision_id: revision.id,
  });
  const before = persisted.sqlite
    .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
    .get(context.session.id);
  const duplicate = await reopened.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId,
            messages: [{ id: "again", role: "user", content: "do it again" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    ),
  );
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ error: "run_already_completed" });
  expect(
    persisted.sqlite
      .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
      .get(context.session.id),
  ).toEqual(before);
  expect(workflowRunEvents(persisted).replay(context.session.id, runId)).toEqual(receipts);
  // Simulate restart recovery classifying an in-flight run as failed. The same ID must
  // not re-enter the model after an uncertain tool-side effect.
  persisted.sqlite.prepare("UPDATE chat_runs SET status = 'failed' WHERE run_id = ?").run(runId);
  const failedRetry = await reopened.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId,
            messages: [{ id: "retry", role: "user", content: "repeat uncertain work" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    ),
  );
  if (failedRetry.status === 200) await failedRetry.text();
  expect(failedRetry.status).toBe(409);
  expect(await failedRetry.json()).toEqual({ error: "run_outcome_uncertain" });
  expect(
    persisted.sqlite
      .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
      .get(context.session.id),
  ).toEqual(before);
});

test("an unresolved bound run cannot be bypassed with a new unbound ID", async () => {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, {
      statement: "Do not repeat an uncertain turn",
      outcomes: ["Only one admitted run"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
  );
  const revision = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare(
        "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  expect(workflowRunBindings(db).bind(context.session.id, "reserved", revision.id).status).toBe(
    "bound",
  );
  const response = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId: "bypass",
            messages: [{ id: "m1", role: "user", content: "repeat it" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    ),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "run_outcome_uncertain" });
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
      .get(context.session.id),
  ).toEqual({ n: 0 });
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM chat_runs WHERE run_id = 'bypass'").get(),
  ).toEqual({ n: 0 });
});

test("a pre-bound run ID cannot be used by another session before SDK run creation", async () => {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const { db, workflows, sessions } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows, sessions: Sessions }),
  );
  const other = await context.runtime.runPromise(sessions.create(context.project.id));
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, {
      statement: "Keep the run pinned",
      outcomes: ["Only this session may use the run"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
  );
  const revision = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare(
        "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  expect(workflowRunBindings(db).bind(context.session.id, "reserved", revision.id).status).toBe(
    "bound",
  );
  const response = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: other.id,
            runId: "reserved",
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        }),
        other.id,
      ),
    ),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "run_id_conflict" });
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?").get(other.id),
  ).toEqual({ n: 0 });
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM chat_runs WHERE run_id = 'reserved'").get(),
  ).toEqual({ n: 0 });
});

test("an unstarted bound run refuses a changed Goal before persisting a user turn", async () => {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  const goal = {
    statement: "Keep the run pinned",
    outcomes: ["Old criterion"],
    constraints: [],
    nonGoals: [],
    assumptions: [],
    openQuestions: [],
    status: "active" as const,
  };
  await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal));
  const revision = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare(
        "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  expect(workflowRunBindings(db).bind(context.session.id, "stale", revision.id).status).toBe(
    "bound",
  );
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, { ...goal, outcomes: ["New criterion"] }),
  );
  const response = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId: "stale",
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    ),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "workflow_changed" });
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
      .get(context.session.id),
  ).toEqual({ n: 0 });
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM chat_runs WHERE run_id = 'stale'").get(),
  ).toEqual({ n: 0 });
});
