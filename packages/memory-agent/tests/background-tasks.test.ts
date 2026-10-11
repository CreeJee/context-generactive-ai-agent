import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Crypto, Deferred, Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { describe, expect, vi } from "vite-plus/test";
import {
  BackgroundTasks,
  BackgroundOperationFailed,
  BackgroundResultStoreFailed,
} from "../src/tools/background.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";
import { withTestPlatform } from "./support/platform.ts";
import { waitUntil } from "./support/wait-until.ts";

const call = Effect.fn("backgroundTask.sdkCall")(<A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const rejects = Effect.fn("backgroundTask.rejects")(function* <A>(
  operation: () => A | PromiseLike<A>,
  message: string,
) {
  const outcome = yield* Effect.result(call(operation));
  Result.match(outcome, {
    onFailure: (error) =>
      expect(() => {
        throw error.cause;
      }).toThrow(message),
    onSuccess: () => expect.fail("Expected the background task operation to reject"),
  });
});

const Receipt = Schema.Struct({
  status: Schema.Literal("running"),
  taskId: Schema.String,
  attemptId: Schema.String,
});
const Page = Schema.Struct({
  status: Schema.String,
  result: Schema.String,
  nextOffset: Schema.NullOr(Schema.Finite),
});

describe("background task lifecycle", () => {
  it.live("simultaneous replay dispatches only one operation", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const { runtime, session } = yield* call(() => testRuntime());
      const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
      const binding = {
        sessionId: session.id,
        runId: yield* crypto.randomUUIDv4(),
        abortSignal: abortSignal,
      };
      const callId = yield* crypto.randomUUIDv4();
      let executions = 0;
      const operation = Effect.sync(() => {
        executions++;
        return "done";
      });
      const receipts = yield* Effect.provideContext(
        Effect.all(
          [
            tasks.start(binding, callId, "shell", "task", operation),
            tasks.start(binding, callId, "shell", "task", operation),
          ],
          { concurrency: "unbounded" },
        ),
        yield* runtime.contextEffect,
      );
      expect(receipts[0]?.taskId).toBe(receipts[1]?.taskId);
      yield* Effect.provideContext(
        tasks.waitResult(session.id, receipts[0]!.taskId, 2000),
        yield* runtime.contextEffect,
      );
      expect(executions).toBe(1);
    }).pipe(withTestPlatform),
  );
  it.live("malformed persisted results fail in the typed storage channel", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const { runtime, session } = yield* call(() => testRuntime());
      const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
      const receipt = yield* Effect.provideContext(
        tasks.start(
          {
            sessionId: session.id,
            runId: yield* crypto.randomUUIDv4(),
            abortSignal: abortSignal,
          },
          yield* crypto.randomUUIDv4(),
          "shell",
          "task",
          Effect.succeed("done"),
        ),
        yield* runtime.contextEffect,
      );
      yield* Effect.provideContext(
        tasks.waitResult(session.id, receipt.taskId, 2000),
        yield* runtime.contextEffect,
      );
      const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
      yield* call(() =>
        state.persistence.stores.metadata.set("background-task-result", receipt.taskId, {
          status: "completed",
        }),
      );
      const exit = yield* Effect.provideContext(
        Effect.exit(tasks.waitResult(session.id, receipt.taskId, 0)),
        yield* runtime.contextEffect,
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") throw new Error("expected storage failure");
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toBeInstanceOf(BackgroundResultStoreFailed);
    }).pipe(withTestPlatform),
  );
  it.live("operation failure is stored once and finalizes the attempt as failed", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const { runtime, session } = yield* call(() => testRuntime());
      const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
      const receipt = yield* Effect.provideContext(
        tasks.start(
          {
            sessionId: session.id,
            runId: yield* crypto.randomUUIDv4(),
            abortSignal: abortSignal,
          },
          yield* crypto.randomUUIDv4(),
          "shell",
          "failing task",
          Effect.fail(new BackgroundOperationFailed({ cause: new Error("execution failed") })),
        ),
        yield* runtime.contextEffect,
      );
      const result = yield* Effect.provideContext(
        tasks.waitResult(session.id, receipt.taskId, 2000),
        yield* runtime.contextEffect,
      );
      expect(result).toMatchObject({ status: "failed" });
      expect(result?.result).toContain("execution failed");
      const trace = yield* Effect.provideContext(WorkTraceStore, yield* runtime.contextEffect);
      expect(trace.taskDetail(session.id, receipt.taskId)?.task.status).toBe("failed");
    }).pipe(withTestPlatform),
  );
  it.live(
    "persistent result write failure records a terminal failure without retry or false completion",
    () =>
      Effect.gen(function* () {
        const abortSignal = yield* Effect.abortSignal;
        const services = yield* Layer.build(NodeCrypto.layer);
        const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
        const { runtime, session } = yield* call(() => testRuntime());
        const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
        const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
        const original = state.persistence.stores.metadata.set.bind(
          state.persistence.stores.metadata,
        );
        let resultWrites = 0;
        const spy = vi
          .spyOn(state.persistence.stores.metadata, "set")
          .mockImplementation((namespace, key, value) => {
            if (namespace === "background-task-result") {
              resultWrites++;
              return Promise.reject(new Error("storage offline"));
            }
            return original(namespace, key, value);
          });
        let notifications = 0;
        tasks.onCompletion(() => {
          notifications++;
        });
        try {
          const receipt = yield* Effect.provideContext(
            tasks.start(
              {
                sessionId: session.id,
                runId: yield* crypto.randomUUIDv4(),
                abortSignal: abortSignal,
              },
              yield* crypto.randomUUIDv4(),
              "shell",
              "task",
              Effect.succeed("operation completed"),
            ),
            yield* runtime.contextEffect,
          );
          const result = yield* Effect.provideContext(
            tasks.waitResult(session.id, receipt.taskId, 2000),
            yield* runtime.contextEffect,
          );
          expect(result).toMatchObject({ status: "failed" });
          expect(result?.result).toContain("background_result_storage_failed");
          const trace = yield* Effect.provideContext(WorkTraceStore, yield* runtime.contextEffect);
          expect(trace.taskDetail(session.id, receipt.taskId)?.task.status).toBe("failed");
          expect(
            yield* call(() =>
              tasks.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId }),
            ),
          ).toMatchObject({ status: "failed" });
          expect(resultWrites).toBe(1);
          expect(notifications).toBe(1);
          expect(tasks.hasSession(session.id)).toBe(false);
        } finally {
          spy.mockRestore();
        }
      }).pipe(withTestPlatform),
  );
  it.live(
    "parent interruption awaits the operation finalizer before recording cancellation",
    () => {
      // This test represents an external SDK caller cancelling its own request.
      const controller = new AbortController();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        const services = yield* Layer.build(NodeCrypto.layer);
        const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
        const { runtime, session } = yield* call(() => testRuntime());
        const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        let started = false;
        let cleaning = false;

        const receipt = yield* Effect.provideContext(
          tasks.start(
            {
              sessionId: session.id,
              runId: yield* crypto.randomUUIDv4(),
              abortSignal: controller.signal,
            },
            yield* crypto.randomUUIDv4(),
            "external_agent",
            "task",
            Effect.sync(() => {
              started = true;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaning = true;
                }).pipe(Effect.andThen(Deferred.await(gate))),
              ),
            ),
          ),
          yield* runtime.contextEffect,
        );
        yield* waitUntil(() => started, "background operation to start", 1000);
        controller.abort();
        yield* waitUntil(() => cleaning, "background finalizer to start", 1000);
        expect(
          yield* call(() => tasks.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId })),
        ).toMatchObject({ status: "running" });
        yield* Effect.provideContext(
          Deferred.succeed(gate, undefined),
          yield* runtime.contextEffect,
        );
        expect(
          yield* Effect.provideContext(
            tasks.waitResult(session.id, receipt.taskId, 2000),
            yield* runtime.contextEffect,
          ),
        ).toMatchObject({ status: "cancelled" });
      }).pipe(withTestPlatform);
    },
  );
  it.live("replayed tool calls retrieve the original operation without repeating effects", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const { runtime, session } = yield* call(() => testRuntime());
      const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
      const binding = {
        sessionId: session.id,
        runId: yield* crypto.randomUUIDv4(),
        abortSignal: abortSignal,
      };
      const callId = yield* crypto.randomUUIDv4();
      let executions = 0;
      const operation = Effect.sync(() => {
        executions++;
        return "done";
      });
      const first = yield* Effect.provideContext(
        tasks.start(binding, callId, "shell", "task", operation),
        yield* runtime.contextEffect,
      );
      yield* Effect.provideContext(
        tasks.waitResult(session.id, first.taskId, 2000),
        yield* runtime.contextEffect,
      );
      const replay = yield* Effect.provideContext(
        tasks.start(binding, callId, "shell", "task", operation),
        yield* runtime.contextEffect,
      );
      expect(replay).toMatchObject({
        taskId: first.taskId,
        attemptId: first.attemptId,
        status: "completed",
      });
      expect(executions).toBe(1);
    }).pipe(withTestPlatform),
  );
  it.live(
    "shell yields before completion, survives parent end, and results remain scoped and durable",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(NodeCrypto.layer);
        const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
        const { runtime, project, session, reopen } = yield* call(() => testRuntime());
        const background = yield* Effect.provideContext(
          BackgroundTasks,
          yield* runtime.contextEffect,
        );
        const approved = yield* Effect.provideContext(ApprovedTools, yield* runtime.contextEffect);
        const abortSignal = yield* Effect.abortSignal;
        const [shell] = approved.forProject(project, "gate", {
          sessionId: session.id,
          runId: yield* crypto.randomUUIDv4(),
          abortSignal: abortSignal,
        });
        const command = `node -e 'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("finished")}},20)'`;
        const shellCallId = yield* crypto.randomUUIDv4();
        const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
          yield* call(() =>
            shell.execute!(
              { command, yieldMs: 0, timeoutSeconds: 5 },
              {
                toolCallId: shellCallId,
                abortSignal: abortSignal,
                emitCustomEvent: () => undefined,
              },
            ),
          ),
        );
        expect(background.hasSession(session.id)).toBe(true);
        const resultTool = background.forSession(session.id)[0]!;
        expect(yield* call(() => resultTool.execute!({ taskId: receipt.taskId }))).toMatchObject({
          status: "running",
        });
        // Independent parent work unlocks the real child process. No wall-clock assertion.
        yield* (yield* FileSystem.FileSystem).writeFileString(
          (yield* Path.Path).join(project.root, "release"),
          "done",
        );
        const finished = yield* Effect.provideContext(
          background.waitResult(session.id, receipt.taskId, 4000),
          yield* runtime.contextEffect,
        );
        expect(finished?.result).toContain("finished");
        const page = yield* Schema.decodeUnknownEffect(Page)(
          yield* call(() => resultTool.execute!({ taskId: receipt.taskId })),
        );
        expect(page.status).toBe("completed");
        const other = yield* Effect.provideContext(
          Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
          yield* runtime.contextEffect,
        );
        yield* rejects(
          () => background.forSession(other.id)[0]!.execute!({ taskId: receipt.taskId }),
          "not found",
        );
        const next = yield* call(() => reopen());
        const reopenedTasks = yield* Effect.provideContext(
          BackgroundTasks,
          yield* next.contextEffect,
        );
        expect(
          yield* call(() =>
            reopenedTasks.forSession(session.id)[0]!.execute!({
              taskId: receipt.taskId,
            }),
          ),
        ).toMatchObject(page);
      }).pipe(withTestPlatform),
  );
  it.live("cancel stops active work and restart never resends an interrupted operation", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const { runtime, session, reopen } = yield* call(() => testRuntime());
      const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
      let started = false;
      let aborted = false;
      const receipt = yield* Effect.provideContext(
        tasks.start(
          {
            sessionId: session.id,
            runId: yield* crypto.randomUUIDv4(),
            abortSignal: abortSignal,
          },
          yield* crypto.randomUUIDv4(),
          "external_agent",
          "synthetic task",
          Effect.sync(() => {
            started = true;
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                aborted = true;
              }),
            ),
          ),
        ),
        yield* runtime.contextEffect,
      );
      yield* waitUntil(() => started, "background operation to start", 1000);
      yield* Effect.provideContext(tasks.stopSession(session.id), yield* runtime.contextEffect);
      expect(aborted).toBe(true);
      expect(
        yield* call(() => tasks.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId })),
      ).toMatchObject({ status: "cancelled" });
      // Simulate a process dying after dispatch with no durable result.
      const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
      yield* call(() =>
        state.persistence.stores.metadata.delete("background-task-result", receipt.taskId),
      );
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      db.sqlite
        .prepare("UPDATE agent_run_attempts SET status='running' WHERE id=?")
        .run(receipt.attemptId);
      db.sqlite
        .prepare("UPDATE work_tasks SET active_attempt_id=?,status='running' WHERE id=?")
        .run(receipt.attemptId, receipt.taskId);
      const next = yield* call(() => reopen());
      const reopened = yield* Effect.provideContext(BackgroundTasks, yield* next.contextEffect);
      expect(reopened.hasSession(session.id)).toBe(false);
      expect(
        yield* call(() => reopened.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId })),
      ).toMatchObject({ status: "interrupted" });
    }).pipe(withTestPlatform),
  );
  it.live("result retrieval neither acknowledges nor consumes a stored result", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const { runtime, session } = yield* call(() => testRuntime());
      const context = yield* runtime.contextEffect;
      const tasks = yield* Effect.provideContext(BackgroundTasks, context);
      const db = yield* Effect.provideContext(Database, context);
      const trace = yield* Effect.provideContext(WorkTraceStore, context);
      const receipt = yield* Effect.provideContext(
        tasks.start(
          { sessionId: session.id, runId: "readonly-run", abortSignal },
          "readonly-call",
          "shell",
          "synthetic read-only contract",
          Effect.succeed("saved result"),
        ),
        context,
      );
      yield* waitUntil(
        () => trace.taskDetail(session.id, receipt.taskId)?.task.status === "completed",
        "background result to finalize",
        2000,
      );
      const changes = db.sqlite.prepare("SELECT total_changes() AS n").get();
      const get = tasks
        .forSession(session.id)
        .find((tool) => tool.name === "get_background_result")!;
      db.sqlite.exec("PRAGMA query_only = ON");
      try {
        const first = yield* call(() => get.execute!({ taskId: receipt.taskId }));
        expect(first).toMatchObject({ status: "completed", result: "saved result" });
        expect(yield* call(() => get.execute!({ taskId: receipt.taskId }))).toEqual(first);
        yield* rejects(() => get.execute!({ taskId: "missing-task" }), "not found");
        expect(db.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
      } finally {
        db.sqlite.exec("PRAGMA query_only = OFF");
      }
    }).pipe(withTestPlatform),
  );
  it.live("paged results stay bounded and task deletion clears their stored payload", () =>
    Effect.gen(function* () {
      const abortSignal = yield* Effect.abortSignal;
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const { runtime, session } = yield* call(() => testRuntime());
      const tasks = yield* Effect.provideContext(BackgroundTasks, yield* runtime.contextEffect);
      const receipt = yield* Effect.provideContext(
        tasks.start(
          {
            sessionId: session.id,
            runId: yield* crypto.randomUUIDv4(),
            abortSignal: abortSignal,
          },
          yield* crypto.randomUUIDv4(),
          "external_agent",
          "task",
          Effect.succeed("x".repeat(6000)),
        ),
        yield* runtime.contextEffect,
      );
      yield* Effect.provideContext(
        tasks.waitResult(session.id, receipt.taskId, 2000),
        yield* runtime.contextEffect,
      );
      const tool = tasks.forSession(session.id)[0]!;
      expect(yield* call(() => tool.execute!({ taskId: receipt.taskId }))).toMatchObject({
        result: "x".repeat(4000),
        nextOffset: 4000,
      });
      expect(
        yield* call(() => tool.execute!({ taskId: receipt.taskId, offset: 4000 })),
      ).toMatchObject({
        result: "x".repeat(2000),
        nextOffset: null,
      });
      const trace = yield* Effect.provideContext(WorkTraceStore, yield* runtime.contextEffect);
      const requested = trace.requestTaskLifecycle({
        sessionId: session.id,
        taskId: receipt.taskId,
        intent: "delete",
        idempotencyKey: yield* crypto.randomUUIDv4(),
      });
      expect(requested.status).toBe("requested");
      if (requested.status !== "requested") throw new Error("delete not requested");
      expect(trace.finalizeTaskLifecycle(requested.operationId).status).toBe("completed");
      const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
      expect(
        yield* call(() =>
          state.persistence.stores.metadata.get("background-task-result", receipt.taskId),
        ),
      ).toBeNull();
      yield* rejects(() => tool.execute!({ taskId: receipt.taskId }), "not found");
    }).pipe(withTestPlatform),
  );
});
