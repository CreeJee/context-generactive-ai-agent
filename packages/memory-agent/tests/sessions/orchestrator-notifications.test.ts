import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { OrchestratorNotifications, Sessions, type MessageDelivery } from "memory-agent";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/**
 * A new conversation of the test project and what puts one message of another conversation, or
 * the end of one background task, in its notifications. Tests in a block share the agent, so
 * every test takes its own target.
 */
const target = Effect.gen(function* () {
  const env = yield* TestEnv;
  const { project, session } = env;
  const to = yield* env.use(Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)));
  const put = (body: string) =>
    env.use(
      Effect.flatMap(OrchestratorNotifications, (notifications) =>
        notifications.put({
          sessionId: to.id,
          sender: "conversation",
          delivery: "next_run",
          payload: { projectId: project.id, fromSessionId: session.id, fromRunId: "run-1", body },
        }),
      ),
    );
  const putTask = (taskId: string, delivery: MessageDelivery) =>
    env.use(
      Effect.flatMap(OrchestratorNotifications, (notifications) =>
        notifications.put({
          sessionId: to.id,
          sender: "task",
          delivery,
          payload: {
            _tag: "BackgroundEnd",
            taskId,
            parentRunId: "run-1",
            kind: "shell",
            title: "ls",
            status: "completed",
          },
        }),
      ),
    );
  return { env, to, put, putTask };
});

const stateOf = (id: string) =>
  sqlGet(
    "SELECT state, claimed_run_id, delivered_run_id FROM orchestrator_notifications WHERE id = ?",
    id,
  );

testAgent()(function (it) {
  it.effect("notifications put for a conversation wait there, oldest first", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const first = yield* put("one");
      const second = yield* put("two");
      expect(first).toEqual({
        id: expect.any(String),
        sessionId: to.id,
        sender: "conversation",
        delivery: "next_run",
        payload: {
          projectId: env.project.id,
          fromSessionId: env.session.id,
          fromRunId: "run-1",
          body: "one",
        },
        state: "waiting",
        deliveredRunId: null,
        createdAt: expect.any(String),
        deliveredAt: null,
      });
      expect(
        yield* env.use(
          Effect.flatMap(OrchestratorNotifications, (notifications) =>
            notifications.pending(to.id),
          ),
        ),
      ).toEqual([first, second]);
    }),
  );

  it.effect("claim hands the waiting rows to one run, once", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const first = yield* put("one");
      const second = yield* put("two");
      const notifications = yield* env.use(OrchestratorNotifications);
      expect(yield* env.use(notifications.claim(to.id, "run-a", "conversation"))).toEqual([
        first,
        second,
      ]);
      // The same run gets nothing the second time, and another run gets nothing either.
      expect(yield* env.use(notifications.claim(to.id, "run-a", "conversation"))).toEqual([]);
      expect(yield* env.use(notifications.claim(to.id, "run-b", "conversation"))).toEqual([]);
    }),
  );

  it.effect("release gives claimed rows to another run", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("retry");
      const notifications = yield* env.use(OrchestratorNotifications);
      expect(yield* env.use(notifications.claim(to.id, "run-a", "conversation"))).toHaveLength(1);
      yield* env.use(notifications.release(to.id, "run-a"));
      expect(yield* env.use(notifications.claim(to.id, "run-b", "conversation"))).toEqual([row]);
    }),
  );

  it.effect("deliverClaimed marks what the run claimed delivered by that run", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("done");
      const notifications = yield* env.use(OrchestratorNotifications);
      yield* env.use(notifications.claim(to.id, "run-a", "conversation"));
      expect(yield* env.use(notifications.deliverClaimed(to.id, "run-a"))).toEqual([row.id]);
      expect(yield* env.use(notifications.pending(to.id))).toEqual([]);
      expect(yield* stateOf(row.id)).toEqual({
        state: "delivered",
        claimed_run_id: null,
        delivered_run_id: "run-a",
      });
    }),
  );

  it.effect("a conversation whose notifications are on hold claims nothing", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("wait out");
      const notifications = yield* env.use(OrchestratorNotifications);
      yield* env.use(
        Effect.flatMap(WorkTraceStore, (trace) => trace.holdParentNotifications(to.id)),
      );
      expect(yield* env.use(notifications.claim(to.id, "run-a", "conversation"))).toEqual([]);
      expect(yield* env.use(notifications.pending(to.id))).toEqual([row]);
    }),
  );

  it.effect("a waiting row survives the agent closing and opening again", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("persist");
      yield* env.reopen;
      expect(
        yield* env.use(
          Effect.flatMap(OrchestratorNotifications, (notifications) =>
            notifications.pending(to.id),
          ),
        ),
      ).toEqual([row]);
    }),
  );

  it.effect("opening settles the claims a dead process left", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const notifications = yield* env.use(OrchestratorNotifications);
      const told = yield* put("told");
      yield* env.use(notifications.claim(to.id, "notifications-run-finished", "conversation"));
      const untold = yield* put("untold");
      yield* env.use(notifications.claim(to.id, "notifications-run-died", "conversation"));
      yield* sqlRun(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES ('notifications-run-finished', ?, 'completed', 1)",
        to.id,
      );
      yield* env.reopen;
      // The finished run handed its row to the model; the other run never finished, so its row
      // waits for the next run again.
      expect(yield* stateOf(told.id)).toEqual({
        state: "delivered",
        claimed_run_id: null,
        delivered_run_id: "notifications-run-finished",
      });
      expect(
        yield* env.use(
          Effect.flatMap(OrchestratorNotifications, (notifications) =>
            notifications.pending(to.id),
          ),
        ),
      ).toEqual([untold]);
    }),
  );

  it.effect("claim takes only the named sender's rows", () =>
    Effect.gen(function* () {
      const { env, to, put, putTask } = yield* target;
      const message = yield* put("one");
      const end = yield* putTask("task-a", "next_run");
      const notifications = yield* env.use(OrchestratorNotifications);
      expect(yield* env.use(notifications.claim(to.id, "run-a", "task"))).toEqual([end]);
      expect(yield* env.use(notifications.claim(to.id, "run-b", "conversation"))).toEqual([
        message,
      ]);
      expect(yield* stateOf(end.id)).toMatchObject({ claimed_run_id: "run-a" });
      expect(yield* stateOf(message.id)).toMatchObject({ claimed_run_id: "run-b" });
    }),
  );

  it.effect(
    "a waiting row that wakes is reported until a run claims it, and not while notifications are held",
    () =>
      Effect.gen(function* () {
        const { env, to, putTask } = yield* target;
        const notifications = yield* env.use(OrchestratorNotifications);
        const wakes = env.use(notifications.wakes(to.id));
        // A row that waits for a run that starts anyway wakes nothing.
        yield* putTask("task-later", "next_run");
        expect(yield* wakes).toBe(false);
        yield* putTask("task-waking", "wake");
        expect(yield* wakes).toBe(true);
        yield* env.use(
          Effect.flatMap(WorkTraceStore, (trace) => trace.holdParentNotifications(to.id)),
        );
        expect(yield* wakes).toBe(false);
        yield* env.use(
          Effect.flatMap(WorkTraceStore, (trace) => trace.resumeParentNotifications(to.id)),
        );
        expect(yield* wakes).toBe(true);
        yield* env.use(notifications.claim(to.id, "run-a", "task"));
        expect(yield* wakes).toBe(false);
      }),
  );

  it.effect("a row put once under an id is stored once", () =>
    Effect.gen(function* () {
      const { env, to } = yield* target;
      const notifications = yield* env.use(OrchestratorNotifications);
      const putOnce = (title: string) =>
        env.use(
          notifications.putOnce({
            id: "task-1",
            sessionId: to.id,
            sender: "task",
            delivery: "wake",
            payload: {
              _tag: "BackgroundEnd",
              taskId: "task-1",
              parentRunId: "run-1",
              kind: "shell",
              title,
              status: "completed",
            },
          }),
        );
      yield* putOnce("ls");
      yield* putOnce("pwd");
      const rows = yield* env.use(notifications.pending(to.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "task-1", payload: { title: "ls" } });
      // A row that was delivered stays delivered when its sender puts it again.
      yield* env.use(notifications.deliver(to.id, "run-a", ["task-1"]));
      yield* putOnce("ls");
      expect(yield* stateOf("task-1")).toEqual({
        state: "delivered",
        claimed_run_id: null,
        delivered_run_id: "run-a",
      });
    }),
  );
});
