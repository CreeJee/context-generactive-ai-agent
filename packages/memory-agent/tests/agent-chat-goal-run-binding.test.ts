const sdkCall = Effect.fn("goalRunBinding.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
import { Cause, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { expect, vi } from "vite-plus/test";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { decodeFullLoopValue } from "../src/agent/full-loop-codec.ts";
import * as workerPreflight from "../src/agent/full-loop-preflight.ts";

it.live.each([false, true])(
  "opt-in AgentChat full worker finalizer failure=%s",
  (failFinalizer) =>
    Effect.gen(function* () {
      try {
        const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
        yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
        const { db, workflows, chat, state } = yield* Effect.provideContext(
          Effect.all({ db: Database, workflows: Workflows, chat: AgentChat, state: ChatState }),
          yield* context.runtime.contextEffect,
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
        yield* Effect.provideContext(
          workflows.updateGoal(context.session.id, {
            statement: "Run safely in worker",
            outcomes: ["One durable turn"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          yield* context.runtime.contextEffect,
        );
        const request = Effect.fn("goalRunBinding.request")(function* (runId: string) {
          return new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: context.session.id,
              runId,
              messages: [{ id: "m1", role: "user", content: "hello" }],
              tools: [],
              context: [],
            }),
          });
        });
        const response = yield* Effect.provideContext(
          chat.handle(yield* request("worker-real"), context.session.id),
          yield* context.runtime.contextEffect,
        );
        expect(response.status).toBe(200);
        const body = yield* sdkCall(() => response.text());
        expect(body).toContain("Hello from fast-1");
        if (failFinalizer) {
          expect(failingCleanup).toHaveBeenCalledTimes(1);
          expect(body.match(/"type":"RUN_ERROR"/g)).toHaveLength(1);
          expect(body).not.toContain("injected owner finalizer failure");
        } else {
          expect(body).not.toContain("RUN_ERROR");
          // The ledger persists canonical {operation,input} in fingerprint, not input_json.
          const receipts = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ fingerprint: Schema.String, status: Schema.String })),
          )(
            db.sqlite
              .prepare("SELECT fingerprint, status FROM owner_rpc_operations WHERE run_id = ?")
              .all("worker-real"),
          );
          const completedHooks = (yield* Effect.forEach(
            receipts,
            Effect.fnUntraced(function* (receipt) {
              const frame = yield* Schema.decodeEffect(
                Schema.fromJsonString(
                  Schema.Struct({ operation: Schema.String, input: Schema.Json }),
                ),
              )(receipt.fingerprint);
              if (frame.operation !== "middleware") return [];
              const input = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ index: Schema.Finite, hook: Schema.String }),
              )(decodeFullLoopValue(frame.input));
              return [
                { name: middlewareNames[input.index], hook: input.hook, status: receipt.status },
              ];
            }),
          )).flat();
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
        const durableExecution = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ status: Schema.String, result_json: Schema.String }),
        )(
          db.sqlite
            .prepare(
              "SELECT status, result_json FROM owner_workflow_executions WHERE json_extract(payload_json, '$.identity.runId') = 'worker-real'",
            )
            .get(),
        );
        expect(durableExecution.status).toBe("completed");
        expect(durableExecution.result_json).toContain(failFinalizer ? "Failure" : "Success");
        if (failFinalizer) expect(durableExecution.result_json).toContain("SideEffectUncertain");
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
              .prepare(
                "SELECT count(*) AS n FROM owner_rpc_operations WHERE run_id = 'worker-real'",
              )
              .get()!.n,
          ),
        ).toBeGreaterThan(0);
        const duplicate = yield* Effect.provideContext(
          chat.handle(yield* request("worker-real"), context.session.id),
          yield* context.runtime.contextEffect,
        );
        expect(duplicate.status).toBe(409);
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
            .get(context.session.id),
        ).toEqual({ n: 1 });
      } finally {
        vi.restoreAllMocks();
      }
    }),
  20000,
);
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../src/workflow/run-events.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

it.live("unsupported opt-in worker preflight creates neither binding nor user node", () =>
  Effect.gen(function* () {
    try {
      const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const { db, workflows, chat, state } = yield* Effect.provideContext(
        Effect.all({ db: Database, workflows: Workflows, chat: AgentChat, state: ChatState }),
        yield* context.runtime.contextEffect,
      );
      const original = state.middleware.bind(state);
      vi.spyOn(state, "middleware").mockImplementation(() => [
        ...original(),
        { name: "unsupported-preflight", unsupportedMember: true },
      ]);
      yield* Effect.provideContext(
        workflows.updateGoal(context.session.id, {
          statement: "Preflight first",
          outcomes: ["No abandoned admission"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
        yield* context.runtime.contextEffect,
      );
      const response = yield* Effect.provideContext(
        chat.handle(
          new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: context.session.id,
              runId: "unsupported-preflight",
              messages: [{ id: "m1", role: "user", content: "hello" }],
              tools: [],
              context: [],
            }),
          }),
          context.session.id,
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(409);
      expect(yield* sdkCall(() => response.json())).toEqual({
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
    }
  }),
);

it.live("new Goal turns automatically acquire a durable worker binding", () =>
  Effect.gen(function* () {
    const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
    yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
    const { db, workflows } = yield* Effect.provideContext(
      Effect.all({ db: Database, workflows: Workflows }),
      yield* context.runtime.contextEffect,
    );
    yield* Effect.provideContext(
      workflows.updateGoal(context.session.id, {
        statement: "Require atomic acceptance",
        outcomes: ["No partial admission"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
      yield* context.runtime.contextEffect,
    );
    for (const runId of ["automatic", "another-automatic"]) {
      const response = yield* Effect.provideContext(
        Effect.flatMap(
          AgentChat,
          Effect.fnUntraced(function* (chat) {
            return yield* chat.handle(
              new Request("http://localhost/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  threadId: context.session.id,
                  runId,
                  messages: [{ id: "m1", role: "user", content: "hello" }],
                  tools: [],
                  context: [],
                }),
              }),
              context.session.id,
            );
          }),
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      expect(yield* sdkCall(() => response.text())).toContain("Hello from fast-1");
      expect(db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId)).toEqual(
        {
          status: "completed",
        },
      );
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
    ).toEqual({ n: 2 });
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM chat_runs WHERE thread_id = ?")
        .get(context.session.id),
    ).toEqual({ n: 2 });
  }),
);

/** Real admission issues the binding and native provenance before the worker runs. */
it.live(
  "a real AgentChat turn keeps its automatically bound Goal version after the owner reopens",
  () =>
    Effect.gen(function* () {
      const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const { db, workflows } = yield* Effect.provideContext(
        Effect.all({ db: Database, workflows: Workflows }),
        yield* context.runtime.contextEffect,
      );
      yield* Effect.provideContext(
        workflows.updateGoal(context.session.id, {
          statement: "Keep an ongoing Goal safe",
          outcomes: ["One recorded turn"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
        yield* context.runtime.contextEffect,
      );
      const revision = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.Finite, goal_instance_id: Schema.String }),
      )(
        db.sqlite
          .prepare(
            "SELECT id, goal_instance_id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(context.session.id),
      );
      const runId = "test-bound-real-agent-run";
      const response = yield* Effect.provideContext(
        Effect.flatMap(
          AgentChat,
          Effect.fnUntraced(function* (chat) {
            return yield* chat.handle(
              new Request("http://localhost/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  threadId: context.session.id,
                  runId,
                  messages: [{ id: "m1", role: "user", content: "hello" }],
                  tools: [],
                  context: [],
                }),
              }),
              context.session.id,
            );
          }),
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      const delivered = yield* sdkCall(() => response.text());
      expect(delivered).toContain("Hello from fast-1");
      const offsets = [...delivered.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
      expect(offsets.length).toBeGreaterThan(1);
      expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:"))).toBe(true);
      const firstOffset = offsets[0]!;
      const replayExpected = delivered.slice(delivered.indexOf("\n\n") + 2);
      const reopened = yield* sdkCall(() => context.reopen());
      const replay = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (chat) =>
          chat.hydrate(
            new Request(`http://localhost/api/chat?runId=${runId}`, {
              headers: { "Last-Event-ID": firstOffset },
            }),
            context.session.id,
          ),
        ),
        yield* reopened.contextEffect,
      );
      expect(replay.status).toBe(200);
      expect(yield* sdkCall(() => replay.text())).toBe(replayExpected);
      for (const badOffset of [
        "memory:v1:wrong:1",
        "sdk-stream:v1:wrong:1",
        `sdk-stream:v1:${runId}:99999999`,
        "now",
      ]) {
        const denied = yield* Effect.provideContext(
          Effect.flatMap(AgentChat, (chat) =>
            chat.hydrate(
              new Request(`http://localhost/api/chat?runId=${runId}`, {
                headers: { "Last-Event-ID": badOffset },
              }),
              context.session.id,
            ),
          ),
          yield* reopened.contextEffect,
        );
        expect(denied.status).toBe(400);
      }
      const other = yield* Effect.provideContext(
        Effect.flatMap(Sessions, (sessions) => sessions.create(context.project.id)),
        yield* reopened.contextEffect,
      );
      const wrongSession = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (chat) =>
          chat.hydrate(
            new Request(`http://localhost/api/chat?runId=${runId}`, {
              headers: { "Last-Event-ID": firstOffset },
            }),
            other.id,
          ),
        ),
        yield* reopened.contextEffect,
      );
      expect(wrongSession.status).toBe(404);
      const persisted = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
      const run = persisted.sqlite
        .prepare("SELECT thread_id, status FROM chat_runs WHERE run_id = ?")
        .get(runId);
      expect(run).toMatchObject({ thread_id: context.session.id, status: "completed" });
      const receipts = workflowRunEvents(persisted).replay(context.session.id, runId);
      expect(receipts.length).toBeGreaterThan(0);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          receipts.map((event) => event.payload),
        ),
      ).toContain("Hello from fast-1");
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
        goal_instance_id: revision.goal_instance_id,
        goal_version: 1,
        workflow_revision_id: revision.id,
      });
      const before = persisted.sqlite
        .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
        .get(context.session.id);
      const duplicate = yield* Effect.provideContext(
        Effect.flatMap(
          AgentChat,
          Effect.fnUntraced(function* (chat) {
            return yield* chat.handle(
              new Request("http://localhost/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  threadId: context.session.id,
                  runId,
                  messages: [{ id: "again", role: "user", content: "do it again" }],
                  tools: [],
                  context: [],
                }),
              }),
              context.session.id,
            );
          }),
        ),
        yield* reopened.contextEffect,
      );
      expect(duplicate.status).toBe(409);
      expect(yield* sdkCall(() => duplicate.json())).toEqual({ error: "run_already_completed" });
      expect(
        persisted.sqlite
          .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
          .get(context.session.id),
      ).toEqual(before);
      expect(workflowRunEvents(persisted).replay(context.session.id, runId)).toEqual(receipts);
      // Simulate restart recovery classifying an in-flight run as failed. The same ID must
      // not re-enter the model after an uncertain tool-side effect.
      persisted.sqlite
        .prepare("UPDATE chat_runs SET status = 'failed' WHERE run_id = ?")
        .run(runId);
      const failedRetry = yield* Effect.provideContext(
        Effect.flatMap(
          AgentChat,
          Effect.fnUntraced(function* (chat) {
            return yield* chat.handle(
              new Request("http://localhost/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  threadId: context.session.id,
                  runId,
                  messages: [{ id: "retry", role: "user", content: "repeat uncertain work" }],
                  tools: [],
                  context: [],
                }),
              }),
              context.session.id,
            );
          }),
        ),
        yield* reopened.contextEffect,
      );
      if (failedRetry.status === 200) yield* sdkCall(() => failedRetry.text());
      expect(failedRetry.status).toBe(409);
      expect(yield* sdkCall(() => failedRetry.json())).toEqual({ error: "run_outcome_uncertain" });
      expect(
        persisted.sqlite
          .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
          .get(context.session.id),
      ).toEqual(before);
    }),
);

it.live("an unresolved bound run cannot be bypassed with a new unbound ID", () =>
  Effect.gen(function* () {
    const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
    yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
    const { db, workflows } = yield* Effect.provideContext(
      Effect.all({ db: Database, workflows: Workflows }),
      yield* context.runtime.contextEffect,
    );
    yield* Effect.provideContext(
      workflows.updateGoal(context.session.id, {
        statement: "Do not repeat an uncertain turn",
        outcomes: ["Only one admitted run"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
      yield* context.runtime.contextEffect,
    );
    const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
      db.sqlite
        .prepare(
          "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(context.session.id),
    );
    expect(workflowRunBindings(db).bind(context.session.id, "reserved", revision.id).status).toBe(
      "bound",
    );
    const response = yield* Effect.provideContext(
      Effect.flatMap(
        AgentChat,
        Effect.fnUntraced(function* (chat) {
          return yield* chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: context.session.id,
                runId: "bypass",
                messages: [{ id: "m1", role: "user", content: "repeat it" }],
                tools: [],
                context: [],
              }),
            }),
            context.session.id,
          );
        }),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(response.status).toBe(409);
    expect(yield* sdkCall(() => response.json())).toEqual({ error: "run_outcome_uncertain" });
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
        .get(context.session.id),
    ).toEqual({ n: 0 });
    expect(
      db.sqlite.prepare("SELECT count(*) AS n FROM chat_runs WHERE run_id = 'bypass'").get(),
    ).toEqual({ n: 0 });
  }),
);

it.live("a pre-bound run ID cannot be used by another session before SDK run creation", () =>
  Effect.gen(function* () {
    const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
    yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
    const { db, workflows, sessions } = yield* Effect.provideContext(
      Effect.all({ db: Database, workflows: Workflows, sessions: Sessions }),
      yield* context.runtime.contextEffect,
    );
    const other = yield* Effect.provideContext(
      sessions.create(context.project.id),
      yield* context.runtime.contextEffect,
    );
    yield* Effect.provideContext(
      workflows.updateGoal(context.session.id, {
        statement: "Keep the run pinned",
        outcomes: ["Only this session may use the run"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
      yield* context.runtime.contextEffect,
    );
    const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
      db.sqlite
        .prepare(
          "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(context.session.id),
    );
    expect(workflowRunBindings(db).bind(context.session.id, "reserved", revision.id).status).toBe(
      "bound",
    );
    const response = yield* Effect.provideContext(
      Effect.flatMap(
        AgentChat,
        Effect.fnUntraced(function* (chat) {
          return yield* chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: other.id,
                runId: "reserved",
                messages: [{ id: "m1", role: "user", content: "hello" }],
                tools: [],
                context: [],
              }),
            }),
            other.id,
          );
        }),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(response.status).toBe(409);
    expect(yield* sdkCall(() => response.json())).toEqual({ error: "run_id_conflict" });
    expect(
      db.sqlite.prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?").get(other.id),
    ).toEqual({ n: 0 });
    expect(
      db.sqlite.prepare("SELECT count(*) AS n FROM chat_runs WHERE run_id = 'reserved'").get(),
    ).toEqual({ n: 0 });
  }),
);

it.live("an unstarted bound run refuses a changed Goal before persisting a user turn", () =>
  Effect.gen(function* () {
    const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
    yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
    const { db, workflows } = yield* Effect.provideContext(
      Effect.all({ db: Database, workflows: Workflows }),
      yield* context.runtime.contextEffect,
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
    yield* Effect.provideContext(
      workflows.updateGoal(context.session.id, goal),
      yield* context.runtime.contextEffect,
    );
    const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
      db.sqlite
        .prepare(
          "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(context.session.id),
    );
    expect(workflowRunBindings(db).bind(context.session.id, "stale", revision.id).status).toBe(
      "bound",
    );
    yield* Effect.provideContext(
      workflows.updateGoal(context.session.id, { ...goal, outcomes: ["New criterion"] }),
      yield* context.runtime.contextEffect,
    );
    const response = yield* Effect.provideContext(
      Effect.flatMap(
        AgentChat,
        Effect.fnUntraced(function* (chat) {
          return yield* chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: context.session.id,
                runId: "stale",
                messages: [{ id: "m1", role: "user", content: "hello" }],
                tools: [],
                context: [],
              }),
            }),
            context.session.id,
          );
        }),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(response.status).toBe(409);
    expect(yield* sdkCall(() => response.json())).toEqual({ error: "workflow_changed" });
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ?")
        .get(context.session.id),
    ).toEqual({ n: 0 });
    expect(
      db.sqlite.prepare("SELECT count(*) AS n FROM chat_runs WHERE run_id = 'stale'").get(),
    ).toEqual({ n: 0 });
  }),
);
