import { Effect, HashSet } from "effect";
import { expect } from "vite-plus/test";
import { OrchestratorNotifications, Sessions, type MessageDelivery } from "memory-agent";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { sqlGet } from "../support/sql.ts";
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
  sqlGet("SELECT state, delivered_run_id FROM orchestrator_notifications WHERE id = ?", id);

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

  it.effect("untold gives the waiting rows the conversation does not tell", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const first = yield* put("one");
      const second = yield* put("two");
      const notifications = yield* env.use(OrchestratorNotifications);
      const untold = (told: HashSet.HashSet<string>) =>
        env.use(notifications.untold(to.id, "conversation", told));
      expect(yield* untold(HashSet.empty())).toEqual([first, second]);
      expect(yield* untold(HashSet.make(first.id))).toEqual([second]);
      // Being given the rows writes nothing: they are given again.
      expect(yield* untold(HashSet.empty())).toEqual([first, second]);
    }),
  );

  it.effect("heard marks the rows the model answered delivered by that run", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const done = yield* put("done");
      const other = yield* put("other");
      const notifications = yield* env.use(OrchestratorNotifications);
      const heard = (delivered: HashSet.HashSet<string>) =>
        env.use(notifications.heard(to.id, "run-a", delivered));
      expect(yield* heard(HashSet.make(done.id))).toEqual([done.id]);
      expect(yield* env.use(notifications.pending(to.id))).toEqual([other]);
      expect(yield* stateOf(done.id)).toEqual({ state: "delivered", delivered_run_id: "run-a" });
      // A row already delivered stays as it is, and no ids mark nothing.
      expect(yield* heard(HashSet.make(done.id))).toEqual([]);
      expect(yield* heard(HashSet.empty())).toEqual([]);
    }),
  );

  it.effect("a conversation whose notifications are on hold is given nothing", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("wait out");
      const notifications = yield* env.use(OrchestratorNotifications);
      yield* env.use(
        Effect.flatMap(WorkTraceStore, (trace) => trace.holdParentNotifications(to.id)),
      );
      expect(yield* env.use(notifications.untold(to.id, "conversation", HashSet.empty()))).toEqual(
        [],
      );
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

  it.effect("untold gives only the named sender's rows", () =>
    Effect.gen(function* () {
      const { env, to, put, putTask } = yield* target;
      const message = yield* put("one");
      const end = yield* putTask("task-a", "next_run");
      const notifications = yield* env.use(OrchestratorNotifications);
      expect(yield* env.use(notifications.untold(to.id, "task", HashSet.empty()))).toEqual([end]);
      expect(yield* env.use(notifications.untold(to.id, "conversation", HashSet.empty()))).toEqual([
        message,
      ]);
    }),
  );

  it.effect(
    "a waiting row that wakes is reported until the model answers it, and not while notifications are held",
    () =>
      Effect.gen(function* () {
        const { env, to, putTask } = yield* target;
        const notifications = yield* env.use(OrchestratorNotifications);
        const wakes = env.use(notifications.wakes(to.id));
        // A row that waits for a run that starts anyway wakes nothing.
        yield* putTask("task-later", "next_run");
        expect(yield* wakes).toBe(false);
        const waking = yield* putTask("task-waking", "wake");
        expect(yield* wakes).toBe(true);
        yield* env.use(
          Effect.flatMap(WorkTraceStore, (trace) => trace.holdParentNotifications(to.id)),
        );
        expect(yield* wakes).toBe(false);
        yield* env.use(
          Effect.flatMap(WorkTraceStore, (trace) => trace.resumeParentNotifications(to.id)),
        );
        expect(yield* wakes).toBe(true);
        // Being given the row changes nothing.
        yield* env.use(notifications.untold(to.id, "task", HashSet.empty()));
        expect(yield* wakes).toBe(true);
        yield* env.use(notifications.heard(to.id, "run-a", HashSet.make(waking.id)));
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
      expect(yield* stateOf("task-1")).toEqual({ state: "delivered", delivered_run_id: "run-a" });
    }),
  );
});
