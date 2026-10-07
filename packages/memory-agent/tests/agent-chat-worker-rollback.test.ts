const sdkCall = Effect.fn("workerRollback.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
import { Cause, ConfigProvider, Effect, Layer, Schema } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";

import { describe, expect } from "vite-plus/test";
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
const request = Effect.fn("workerRollback.request")(function* (sessionId: string, runId: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Run-Id": runId },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      threadId: sessionId,
      runId,
      messages: [{ id: `user-${runId}`, role: "user", content: `hello ${runId}` }],
      tools: [],
      context: [],
    }),
  });
});
const offsets = (stream: string) => [...stream.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);

// Each turn receives an explicit configuration; worker and legacy paths share the same owner.
describe("real AgentChat worker opt-in rollback", { concurrent: false }, () => {
  it.live("completed worker evidence survives rollback, a legacy turn and owner reopen", () =>
    Effect.gen(function* () {
      let workerEnabled = true;
      const withWorkerFlag = Effect.fn("workerRollback.withWorkerFlag")(function* <A, E, R>(
        program: Effect.Effect<A, E, R>,
      ) {
        const services = yield* Layer.build(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({ CONTEXT_AGENT_GOAL_WORKER: workerEnabled ? "1" : "0" }),
            { asPrimary: true },
          ),
        );
        return yield* Effect.provideContext(program, services);
      });
      {
        const context = yield* sdkCall(() =>
          testRuntime({
            testProvider: { responder: () => ({ text: "durable answer" }) },
          }),
        );
        yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
        const owner = yield* Effect.provideContext(
          Effect.all({ db: Database, chat: AgentChat, workflows: Workflows }),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        yield* Effect.provideContext(
          owner.workflows.updateGoal(context.session.id, goal),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        const workerRun = "rollback-completed-worker";
        const response = yield* Effect.provideContext(
          owner.chat.handle(yield* request(context.session.id, workerRun), context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        expect(response.status).toBe(200);
        const delivered = yield* sdkCall(() => response.text());
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
        const snapshot = Effect.fn("workerRollback.snapshot")(function* (db: Database["Service"]) {
          return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
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
        });
        const before = yield* snapshot(owner.db);
        const historyRequest = () =>
          new Request(`http://localhost/api/chat?threadId=${context.session.id}`);
        const initialHistory = yield* Schema.decodeUnknownEffect(History)(
          yield* Effect.provideContext(
            owner.chat.hydrate(historyRequest(), context.session.id),
            yield* context.runtime.contextEffect,
          ).pipe(
            withWorkerFlag,
            Effect.flatMap((response) => sdkCall(() => response.json())),
          ),
        );
        const storedTranscript = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          owner.db.sqlite
            .prepare("SELECT * FROM chat_threads WHERE thread_id = ?")
            .get(context.session.id),
        );
        const repeatedHistory = yield* Schema.decodeUnknownEffect(History)(
          yield* Effect.provideContext(
            owner.chat.hydrate(historyRequest(), context.session.id),
            yield* context.runtime.contextEffect,
          ).pipe(
            withWorkerFlag,
            Effect.flatMap((response) => sdkCall(() => response.json())),
          ),
        );
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            repeatedHistory.messages,
          ),
        ).toBe(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            initialHistory.messages,
          ),
        );
        const newestPage = yield* Schema.decodeUnknownEffect(History)(
          yield* Effect.provideContext(
            owner.chat.hydrate(new Request(`${historyRequest().url}&limit=1`), context.session.id),
            yield* context.runtime.contextEffect,
          ).pipe(
            withWorkerFlag,
            Effect.flatMap((response) => sdkCall(() => response.json())),
          ),
        );
        expect(newestPage.messages).toEqual(initialHistory.messages.slice(-1));
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            owner.db.sqlite
              .prepare("SELECT * FROM chat_threads WHERE thread_id = ?")
              .get(context.session.id),
          ),
        ).toBe(storedTranscript);
        workerEnabled = false;
        const legacyRun = "rollback-new-legacy";
        const legacy = yield* Effect.provideContext(
          owner.chat.handle(yield* request(context.session.id, legacyRun), context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        expect(legacy.status).toBe(200);
        const legacyStream = yield* sdkCall(() => legacy.text());
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
        expect(yield* snapshot(owner.db)).toBe(before);
        const legacyCursor = offsets(legacyStream)[0]!;
        expect(legacyCursor).toMatch(new RegExp(`^memory:v1:${legacyRun}:`));
        const join = (runId: string, offset: string) =>
          new Request(`http://localhost/api/chat?runId=${runId}`, {
            headers: { "Last-Event-ID": offset },
          });
        const legacyReplay = yield* Effect.provideContext(
          owner.chat.hydrate(join(legacyRun, legacyCursor), context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        expect(legacyReplay.status).toBe(200);
        expect(yield* sdkCall(() => legacyReplay.text())).toBe(
          legacyStream.slice(legacyStream.indexOf("\n\n") + 2),
        );
        for (const [runId, offset] of [
          [legacyRun, cursor],
          [workerRun, legacyCursor],
        ]) {
          const wrong = yield* Effect.provideContext(
            owner.chat.hydrate(join(runId!, offset!), context.session.id),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          expect(wrong.status).toBe(400);
          expect(yield* sdkCall(() => wrong.json())).toEqual({ error: "invalid_stream_offset" });
        }
        const reopened = yield* sdkCall(() => context.reopen());
        const after = yield* Effect.provideContext(
          Effect.all({ db: Database, chat: AgentChat }),
          yield* reopened.contextEffect,
        ).pipe(withWorkerFlag);
        expect(yield* snapshot(after.db)).toBe(before);
        const replay = yield* Effect.provideContext(
          after.chat.hydrate(join(workerRun, cursor), context.session.id),
          yield* reopened.contextEffect,
        ).pipe(withWorkerFlag);
        expect(replay.status).toBe(200);
        expect(yield* sdkCall(() => replay.text())).toBe(
          delivered.slice(delivered.indexOf("\n\n") + 2),
        );
        const history = yield* Schema.decodeUnknownEffect(History)(
          yield* Effect.provideContext(
            after.chat.hydrate(historyRequest(), context.session.id),
            yield* reopened.contextEffect,
          ).pipe(
            withWorkerFlag,
            Effect.flatMap((response) => sdkCall(() => response.json())),
          ),
        );
        // Hydration may add the later turn, but the former turn's messages must be unchanged.
        expect(history.messages.slice(0, initialHistory.messages.length)).toEqual(
          initialHistory.messages,
        );
        expect(history.messages).toHaveLength(4);
        expect(context.provider!.adapter.invocations).toHaveLength(2);
      }
    }),
  );

  it.live("opt-in off cannot retry or bypass an uncertain worker outcome after reopen", () =>
    Effect.gen(function* () {
      let workerEnabled = true;
      const withWorkerFlag = Effect.fn("workerRollback.withWorkerFlag")(function* <A, E, R>(
        program: Effect.Effect<A, E, R>,
      ) {
        const services = yield* Layer.build(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({ CONTEXT_AGENT_GOAL_WORKER: workerEnabled ? "1" : "0" }),
            { asPrimary: true },
          ),
        );
        return yield* Effect.provideContext(program, services);
      });
      {
        const context = yield* sdkCall(() =>
          testRuntime({
            testProvider: {
              responder: () => ({
                text: "committed partial",
                failAfterText: "deterministic rollback failure",
              }),
            },
          }),
        );
        yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
        const owner = yield* Effect.provideContext(
          Effect.all({ db: Database, chat: AgentChat, workflows: Workflows }),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        yield* Effect.provideContext(
          owner.workflows.updateGoal(context.session.id, goal),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        const runId = "rollback-uncertain-worker";
        const response = yield* Effect.provideContext(
          owner.chat.handle(yield* request(context.session.id, runId), context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(withWorkerFlag);
        expect(response.status).toBe(200);
        expect(yield* sdkCall(() => response.text())).toContain("RUN_ERROR");
        expect(
          owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
        ).toEqual({ status: "failed" });
        const receipts = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          owner.db.sqlite
            .prepare("SELECT * FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id")
            .all(runId),
        );
        workerEnabled = false;
        for (const restart of [false, true]) {
          const runtime = restart ? yield* sdkCall(() => context.reopen()) : context.runtime;
          const current = yield* Effect.provideContext(
            Effect.all({ chat: AgentChat, db: Database }),
            yield* runtime.contextEffect,
          ).pipe(withWorkerFlag);
          for (const id of [runId, "rollback-uncertain-new-id"]) {
            const retry = yield* Effect.provideContext(
              current.chat.handle(yield* request(context.session.id, id), context.session.id),
              yield* runtime.contextEffect,
            ).pipe(withWorkerFlag);
            expect(retry.status).toBe(409);
            expect(yield* sdkCall(() => retry.json())).toEqual({ error: "run_outcome_uncertain" });
          }
          expect(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              current.db.sqlite
                .prepare(
                  "SELECT * FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id",
                )
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
      }
    }),
  );
});
