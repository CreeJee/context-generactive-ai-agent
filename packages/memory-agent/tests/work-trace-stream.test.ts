import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};

const run = <A>(effect: Effect.Effect<A, never, Database | WorkTraceStore>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(testLayer()))));

const seed = (db: Database["Service"]) => {
  const iso = new Date(0).toISOString();
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
  test("replays visible events by durable cursor and redacts payloads", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research the code",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "private reasoning",
          visibility: "internal",
          payload: { secret: "never-return" },
        });
        const redacted = trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Sensitive tool activity",
          redaction: "redacted",
          payload: { secret: "never-return" },
        });
        const visible = trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Checked source files",
          payload: { count: 3 },
        });

        const snapshot = trace.events("s1", 0);
        expect(snapshot.map((event) => event.cursor)).toEqual([1, redacted.cursor, visible.cursor]);
        expect(snapshot[1]?.payload).toEqual({});
        expect(snapshot[2]?.payload).toEqual({ count: 3 });
        expect(trace.events("s1", redacted.cursor).map((event) => event.id)).toEqual([visible.id]);
        expect(trace.latestCursor("s1")).toBe(visible.cursor);

        const omitted = trace.appendEvent({
          handle,
          sessionId: "s1",
          kind: "activity",
          summary: "Omitted payload",
          redaction: "omitted",
        });
        const durableSnapshot = trace.snapshot("s1", redacted.cursor);
        expect(durableSnapshot).toEqual({
          cursor: omitted.cursor,
          events: [expect.objectContaining({ id: visible.id })],
        });
        expect(trace.taskTree("s1")).toEqual([
          expect.objectContaining({
            id: handle.taskId,
            parentRunId: "parent-1",
            parentToolCallId: "call-1",
            latestAttemptId: handle.id,
            latestAttemptStatus: "queued",
          }),
        ]);
        expect(trace.taskDetail("s1", handle.taskId)).toEqual(
          expect.objectContaining({
            task: expect.objectContaining({ id: handle.taskId }),
            attempts: [expect.objectContaining({ id: handle.id, chatRunId: handle.chatRunId })],
            checkpoints: [],
          }),
        );
      }),
    );
  });

  test("wakes a live tail on an appended event and emits an idle heartbeat", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research the code",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        const cursor = trace.latestCursor("s1");
        const controller = new AbortController();
        const waiting = trace.waitForChange("s1", cursor, controller.signal, 1_000);
        queueMicrotask(() =>
          trace.appendEvent({
            handle,
            sessionId: "s1",
            kind: "activity",
            summary: "Continued",
          }),
        );
        expect(yield* Effect.promise(() => waiting)).toBe("event");
        const latest = trace.latestCursor("s1");
        expect(trace.events("s1", cursor)).toHaveLength(1);
        expect(
          yield* Effect.promise(() => trace.waitForChange("s1", latest, controller.signal, 5)),
        ).toBe("heartbeat");
        controller.abort();
        expect(
          yield* Effect.promise(() => trace.waitForChange("s1", latest, controller.signal, 5)),
        ).toBe("aborted");
      }),
    );
  });
});
