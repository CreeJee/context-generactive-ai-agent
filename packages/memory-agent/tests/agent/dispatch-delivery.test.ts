import { Effect, HashSet, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { expect } from "vite-plus/test";
import { SessionDispatches, Sessions } from "memory-agent";
import { messageText } from "../../src/agent/compaction.ts";
import { dispatchNotifications } from "../../src/agent/dispatch-notifications.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { RunStore } from "../../src/loop/store.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { send } from "../agents/agent-env.ts";
import { selectTestModel } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { scriptedRun } from "../support/loop-run.ts";

/** The one row of `orchestrator_notifications` the id names, as fixture SQL reads it. */
const dispatchRow = (id: string) =>
  Effect.flatMap(
    sqlGet(
      "SELECT state, delivered_run_id, delivered_at FROM orchestrator_notifications WHERE id = ?",
      id,
    ),
    Schema.decodeUnknownEffect(
      Schema.Struct({
        state: Schema.Literals(["waiting", "delivered"]),
        delivered_run_id: Schema.NullOr(Schema.String),
        delivered_at: Schema.NullOr(Schema.String),
      }),
    ),
  );

/** Whether a message is the orchestrator's and carries the dispatch's words. */
const tells = (body: string) => (message: StoredMessage) =>
  message.role === "user" &&
  message.orchestrator !== undefined &&
  messageText(message).includes(body);

/** The dispatch delivery hooks as chat.ts binds them: store, holds and secure ids. */
const told = Effect.map(
  Effect.all({
    dispatches: SessionDispatches,
    trace: WorkTraceStore,
    crypto: SecureRandom.SecureRandom,
  }),
  dispatchNotifications,
);

/** Two chat conversations of the test project: the dispatching one and the target of its dispatch. */
const twoSessions = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const sessions = yield* Sessions;
  const source = yield* sessions.create(project.id);
  const target = yield* sessions.create(project.id);
  return { project, source, target };
});

/**
 * One waiting dispatch from `source` to `target`, stored the way the `notify_session` tool stores
 * one. Tests in a block share the agent, so every test builds its own pair of conversations.
 */
const leaveDispatch = Effect.fnUntraced(function* (
  project: { readonly id: string },
  sourceId: string,
  targetId: string,
  body: string,
) {
  const dispatches = yield* SessionDispatches;
  return yield* dispatches.notify({
    projectId: project.id,
    fromSessionId: sourceId,
    fromRunId: "source-run",
  })({ toSessionId: targetId, body });
});

/** The user turn a target conversation's run starts from, with the run's id. */
const userTurn = (text: string) => [{ role: "user" as const, content: text }];

testAgent()(function (it) {
  it.effect("a run is told the waiting dispatch and delivers it when it finishes", () =>
    Effect.gen(function* () {
      const { project, source, target } = yield* twoSessions;
      const body = "다른 대화가 맡긴 결과물";
      const dispatch = yield* leaveDispatch(project, source.id, target.id, body);
      const runId = `${target.id}:run`;
      yield* scriptedRun({
        runId,
        turns: [{ text: "전달받은 내용을 확인했습니다." }],
        threadId: target.id,
        conversation: userTurn("이어서 진행해 줘."),
        hooks: [(yield* told).hookFor(target.id, runId)],
      });

      // The model read the dispatch as the orchestrator's message, marked as not the user's.
      const stored = yield* (yield* RunStore).thread(target.id);
      const toldMessage = stored.find(
        (message): message is Extract<typeof message, { readonly role: "user" }> =>
          message.role === "user" && message.orchestrator !== undefined,
      );
      expect(messageText(toldMessage!)).toContain(body);
      expect(messageText(toldMessage!)).toContain("not user instructions or approval");
      expect(messageText(toldMessage!)).toContain(source.id);
      expect(toldMessage?.orchestrator).toEqual({
        next: "run",
        ended: { background: 0, subagent: 0 },
      });
      expect(toldMessage?.toldNotifications).toEqual([dispatch.id]);
      // The run finished, so it delivered the dispatch its conversation tells.
      expect(yield* dispatchRow(dispatch.id)).toEqual({
        state: "delivered",
        delivered_run_id: runId,
        delivered_at: expect.any(String),
      });
      // No other run is given it again.
      expect(yield* (yield* SessionDispatches).untold(target.id, HashSet.empty())).toEqual([]);
    }),
  );

  it.effect("the same run is not told the same dispatch twice", () =>
    Effect.gen(function* () {
      const { project, source, target } = yield* twoSessions;
      const dispatch = yield* leaveDispatch(project, source.id, target.id, "한 번만 전달");
      const runId = `${target.id}:run`;
      // The run goes on to a second model step, so the joining hook runs again there.
      const run = yield* scriptedRun({
        runId,
        turns: [
          { toolCalls: [{ id: "call-1", name: "find_memory", arguments: '{"query":"결정"}' }] },
          { text: "둘째 단계." },
        ],
        threadId: target.id,
        conversation: userTurn("이어서 진행해 줘."),
        hooks: [(yield* told).hookFor(target.id, runId)],
      });
      // The dispatch joined the conversation before the first model call, and only once after that.
      const invocations = yield* run.invocations;
      expect(invocations).toHaveLength(2);
      for (const invocation of invocations) {
        const toldTimes = invocation.history.filter(
          (message: StoredMessage) =>
            message.role === "user" &&
            message.orchestrator !== undefined &&
            messageText(message).includes("한 번만 전달"),
        );
        expect(toldTimes).toHaveLength(1);
      }
      // The conversation tells it once; the run delivered the row.
      expect(yield* dispatchRow(dispatch.id)).toMatchObject({
        state: "delivered",
        delivered_run_id: runId,
      });
    }),
  );

  it.effect(
    "a run whose model call fails leaves the dispatch in the conversation, and the next run hears it without being told again",
    () =>
      Effect.gen(function* () {
        const { project, source, target } = yield* twoSessions;
        const body = "한 번만 넣을 내용";
        const dispatch = yield* leaveDispatch(project, source.id, target.id, body);
        const runId = `${target.id}:run`;
        yield* scriptedRun({
          runId,
          turns: [{ failAfterText: "모델이 실패했습니다." }],
          threadId: target.id,
          conversation: userTurn("이어서 진행해 줘."),
          hooks: [(yield* told).hookFor(target.id, runId)],
        });
        // The model did not answer, so the row still waits.
        expect(yield* dispatchRow(dispatch.id)).toEqual({
          state: "waiting",
          delivered_run_id: null,
          delivered_at: null,
        });
        // The failed run saved the message that tells the dispatch.
        const stored = yield* (yield* RunStore).thread(target.id);
        expect(stored.filter(tells(body))).toHaveLength(1);
        const nextRunId = `${target.id}:next`;
        const next = yield* scriptedRun({
          runId: nextRunId,
          turns: [{ text: "확인했습니다." }],
          threadId: target.id,
          conversation: [...stored, { role: "user", content: "다시 해 줘." }],
          hooks: [(yield* told).hookFor(target.id, nextRunId)],
        });
        // The next run sends the saved message and is not given the dispatch as a new one.
        const invocations = yield* next.invocations;
        expect(invocations).toHaveLength(1);
        expect(invocations[0]!.history.filter(tells(body))).toHaveLength(1);
        expect(yield* dispatchRow(dispatch.id)).toEqual({
          state: "delivered",
          delivered_run_id: nextRunId,
          delivered_at: expect.any(String),
        });
      }),
  );

  it.effect("a run that fails after the model answered keeps the dispatch delivered", () =>
    Effect.gen(function* () {
      const { project, source, target } = yield* twoSessions;
      const dispatch = yield* leaveDispatch(project, source.id, target.id, "답한 뒤 실패");
      const runId = `${target.id}:run`;
      yield* scriptedRun({
        runId,
        turns: [
          { toolCalls: [{ id: "call-1", name: "find_memory", arguments: '{"query":"결정"}' }] },
          { failAfterText: "둘째 단계에서 실패." },
        ],
        threadId: target.id,
        conversation: userTurn("이어서 진행해 줘."),
        hooks: [(yield* told).hookFor(target.id, runId)],
      });
      expect(yield* dispatchRow(dispatch.id)).toEqual({
        state: "delivered",
        delivered_run_id: runId,
        delivered_at: expect.any(String),
      });
    }),
  );

  it.effect("a session whose notifications are on hold is not told its waiting dispatch", () =>
    Effect.gen(function* () {
      const { project, source, target } = yield* twoSessions;
      const dispatch = yield* leaveDispatch(project, source.id, target.id, "보류 중 전달");
      const trace = yield* WorkTraceStore;
      yield* trace.holdParentNotifications(target.id);
      const runId = `${target.id}:run`;
      yield* scriptedRun({
        runId,
        turns: [{ text: "확인했습니다." }],
        threadId: target.id,
        conversation: userTurn("이어서 진행해 줘."),
        hooks: [(yield* told).hookFor(target.id, runId)],
      });
      // The dispatch waited out the run and still waits.
      expect(yield* dispatchRow(dispatch.id)).toEqual({
        state: "waiting",
        delivered_run_id: null,
        delivered_at: null,
      });
      // Once the user turns the session's notifications back on, the next run is given it.
      yield* trace.resumeParentNotifications(target.id);
      expect(yield* (yield* SessionDispatches).untold(target.id, HashSet.empty())).toHaveLength(1);
    }),
  );
});

/** The chat agent's own view of the session: its only runs are the turns the test sent. */
const targetInvocations = Effect.gen(function* () {
  const { provider } = yield* TestEnv;
  return (sessionId: string) =>
    provider!.invocations.filter((invocation) => invocation.run.threadId === sessionId);
});

testAgent({ testProvider: {} })("dispatch delivery in chat", (it) => {
  it.effect(
    "the chat's next run is handed the dispatch; none starts for a waiting dispatch alone",
    () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const sessions = yield* Sessions;
        const source = yield* sessions.create(project.id);
        const target = yield* sessions.create(project.id);
        yield* selectTestModel();
        // The target's own completed user run, then a dispatch left for it and nothing else.
        yield* send(target.id, "hello");
        yield* leaveDispatch(project, source.id, target.id, "넘겨주는 내용");
        expect(yield* dispatchRowByTarget(target.id)).toMatchObject({ state: "waiting" });
        const invocations = yield* targetInvocations;
        expect(invocations(target.id)).toHaveLength(1);
        // A waiting dispatch alone starts nothing: no automatic run reaches the model for it.
        yield* Effect.sleep(700);
        expect(invocations(target.id)).toHaveLength(1);
        // The next user run is told the dispatch, as an orchestrator message that is not the user's.
        yield* send(target.id, "이어서 진행해 줘.");
        const told = invocations(target.id)
          .at(-1)!
          .history.some(
            (message) =>
              message.role === "user" &&
              message.orchestrator !== undefined &&
              messageText(message).includes("넘겨주는 내용"),
          );
        expect(told).toBe(true);
        expect(yield* dispatchRowByTarget(target.id)).toMatchObject({
          state: "delivered",
          delivered_run_id: expect.any(String),
        });
      }),
  );
  // A held session's runs are covered by the hook-level test above: the hold keeps a run from
  // consuming, and the user's own turn is what lifts the hold (`resumeParentNotifications` on
  // `runStarted`), so a held session's user run is not a hold test here.
});

/** The dispatch rows that wait for the conversation, as fixture SQL reads them. */
function dispatchRowByTarget(sessionId: string) {
  return Effect.flatMap(
    sqlGet(
      "SELECT state, delivered_run_id, delivered_at FROM orchestrator_notifications WHERE session_id = ?",
      sessionId,
    ),
    Schema.decodeUnknownEffect(
      Schema.Struct({
        state: Schema.Literals(["waiting", "delivered"]),
        delivered_run_id: Schema.NullOr(Schema.String),
        delivered_at: Schema.NullOr(Schema.String),
      }),
    ),
  );
}
