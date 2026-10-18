import { it } from "@effect/vitest";
import { DateTime, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkTraceReadFailed, WorkTraceStore } from "../src/work-trace/store.ts";

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};

const run = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const services = yield* Layer.build(testLayer());
  return yield* Effect.provideContext(effect, services);
});

const seed = (db: Database["Service"]) => {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(0));
  db.sqlite
    .prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)")
    .run(iso);
  db.sqlite
    .prepare(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    )
    .run(iso);
  db.sqlite
    .prepare(
      `INSERT INTO subagents
       (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
       VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`,
    )
    .run();
};

describe("Work Trace durable stream source", () => {
  it.effect("replays visible events by durable cursor and redacts payloads", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research the code",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        yield* trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "private reasoning",
          visibility: "internal",
          payload: { secret: "never-return" },
        });
        const redacted = yield* trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Sensitive tool activity",
          redaction: "redacted",
          payload: { secret: "never-return" },
        });
        const visible = yield* trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Checked source files",
          payload: { count: 3 },
        });

        const snapshot = yield* trace.events("s1", 0);
        expect(snapshot.map((event) => event.cursor)).toEqual([1, redacted.cursor, visible.cursor]);
        expect(snapshot[1]?.payload).toEqual({});
        expect(snapshot[2]?.payload).toEqual({ count: 3 });
        expect((yield* trace.events("s1", redacted.cursor)).map((event) => event.id)).toEqual([
          visible.id,
        ]);
        expect(yield* trace.latestCursor("s1")).toBe(visible.cursor);

        const omitted = yield* trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Omitted payload",
          redaction: "omitted",
        });
        const durableSnapshot = yield* trace.snapshot("s1", redacted.cursor);
        expect(durableSnapshot).toEqual({
          cursor: omitted.cursor,
          events: [expect.objectContaining({ id: visible.id })],
        });
        expect(yield* trace.taskTree("s1")).toEqual([
          expect.objectContaining({
            id: handle.taskId,
            parentRunId: "parent-1",
            parentToolCallId: "call-1",
            latestAttemptId: handle.id,
            latestAttemptStatus: "queued",
          }),
        ]);
        expect(yield* trace.taskDetail("s1", handle.taskId)).toEqual(
          expect.objectContaining({
            task: expect.objectContaining({ id: handle.taskId }),
            attempts: [expect.objectContaining({ id: handle.id, chatRunId: handle.chatRunId })],
            checkpoints: [],
          }),
        );
      }),
    ),
  );

  it.effect("wakes a live tail on an appended event and emits an idle heartbeat", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research the code",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        const cursor = yield* trace.latestCursor("s1");
        const waiting = yield* trace
          .waitForChangeEffect({
            sessionId: "s1",
            afterCursor: cursor,
            heartbeatMs: 1_000,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Continued",
        });
        expect(yield* Fiber.join(waiting)).toBe("event");
        const latest = yield* trace.latestCursor("s1");
        expect(yield* trace.events("s1", cursor)).toHaveLength(1);
        const heartbeat = yield* trace
          .waitForChangeEffect({
            sessionId: "s1",
            afterCursor: latest,
            heartbeatMs: 5,
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(5);
        expect(yield* Fiber.join(heartbeat)).toBe("heartbeat");
      }),
    ),
  );

  it.effect("interrupts a waiting tail without converting cancellation to a heartbeat", () =>
    run(
      Effect.gen(function* () {
        seed(yield* Database);
        const trace = yield* WorkTraceStore;
        const waiting = yield* trace
          .waitForChangeEffect({
            sessionId: "s1",
            afterCursor: 0,
            heartbeatMs: 1_000,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        const exit = yield* Fiber.await(waiting);
        expect(Exit.hasInterrupts(exit)).toBe(true);
      }),
    ),
  );

  it.live("preserves the native aborted-wait contract", () =>
    run(
      Effect.gen(function* () {
        seed(yield* Database);
        const trace = yield* WorkTraceStore;
        const signalScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        const signal = yield* Effect.provideService(Effect.abortSignal, Scope.Scope, signalScope);
        const waiting = trace.waitForChange("s1", 0, signal, 1_000);
        yield* Scope.close(signalScope, Exit.void);
        expect(yield* Effect.promise(() => waiting)).toBe("aborted");
      }),
    ),
  );

  it.effect("reports a durable cursor read failure in the typed error channel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        seed(db);
        db.sqlite.exec("DROP TABLE run_events");
        const trace = yield* WorkTraceStore;
        const failure = yield* trace
          .waitForChangeEffect({
            sessionId: "s1",
            afterCursor: 0,
          })
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(WorkTraceReadFailed);
        expect(failure.operation).toBe("latest_cursor");
        expect(failure.reason._tag).toBe("ReadFailed");
      }),
    ),
  );
});
