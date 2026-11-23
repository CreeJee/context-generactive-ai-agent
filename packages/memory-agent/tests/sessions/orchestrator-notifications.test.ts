import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { OrchestratorNotifications, Sessions } from "memory-agent";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/**
 * A new conversation of the test project and what puts one message of another conversation in its
 * notifications. Tests in a block share the agent, so every test takes its own target.
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
  return { env, to, put };
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
      expect(yield* env.use(notifications.claim(to.id, "run-a"))).toEqual([first, second]);
      // The same run gets nothing the second time, and another run gets nothing either.
      expect(yield* env.use(notifications.claim(to.id, "run-a"))).toEqual([]);
      expect(yield* env.use(notifications.claim(to.id, "run-b"))).toEqual([]);
    }),
  );

  it.effect("release gives claimed rows to another run", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("retry");
      const notifications = yield* env.use(OrchestratorNotifications);
      expect(yield* env.use(notifications.claim(to.id, "run-a"))).toHaveLength(1);
      yield* env.use(notifications.release(to.id, "run-a"));
      expect(yield* env.use(notifications.claim(to.id, "run-b"))).toEqual([row]);
    }),
  );

  it.effect("deliverClaimed marks what the run claimed delivered by that run", () =>
    Effect.gen(function* () {
      const { env, to, put } = yield* target;
      const row = yield* put("done");
      const notifications = yield* env.use(OrchestratorNotifications);
      yield* env.use(notifications.claim(to.id, "run-a"));
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
      expect(yield* env.use(notifications.claim(to.id, "run-a"))).toEqual([]);
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
      yield* env.use(notifications.claim(to.id, "inbox-run-finished"));
      const untold = yield* put("untold");
      yield* env.use(notifications.claim(to.id, "inbox-run-died"));
      yield* sqlRun(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES ('inbox-run-finished', ?, 'completed', 1)",
        to.id,
      );
      yield* env.reopen;
      // The finished run handed its row to the model; the other run never finished, so its row
      // waits for the next run again.
      expect(yield* stateOf(told.id)).toEqual({
        state: "delivered",
        claimed_run_id: null,
        delivered_run_id: "inbox-run-finished",
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
});
