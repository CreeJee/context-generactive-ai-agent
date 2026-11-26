import { Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { expect } from "vite-plus/test";
import { OrchestratorNotifications, Sessions } from "memory-agent";
import { messageText } from "../../src/agent/compaction.ts";
import { taskNotifications } from "../../src/agent/task-notifications.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { RunStore } from "../../src/loop/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlGet } from "../support/sql.ts";
import { scriptedRun } from "../support/loop-run.ts";

/** The one row of `orchestrator_notifications` the id names, as fixture SQL reads it. */
const changeRow = (id: string) =>
  Effect.flatMap(
    sqlGet("SELECT state, delivered_run_id FROM orchestrator_notifications WHERE id = ?", id),
    Schema.decodeUnknownEffect(
      Schema.Struct({
        state: Schema.Literals(["waiting", "delivered"]),
        delivered_run_id: Schema.NullOr(Schema.String),
      }),
    ),
  );

/** Whether a message is the orchestrator's and carries the status change's words. */
const tells = (summary: string) => (message: StoredMessage) =>
  message.role === "user" &&
  message.orchestrator !== undefined &&
  messageText(message).includes(summary);

/** The task notification hooks as chat.ts binds them: the notifications and secure ids. */
const told = Effect.map(
  Effect.all({ notifications: OrchestratorNotifications, crypto: SecureRandom.SecureRandom }),
  taskNotifications,
);

/** A new conversation of the test project. Tests in a block share the agent, so each takes its own. */
const conversation = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  return yield* (yield* Sessions).create(project.id);
});

/** One waiting status change of a task the conversation started, under the id `id`. */
const leaveChange = (sessionId: string, id: string, summary: string) =>
  Effect.flatMap(OrchestratorNotifications, (notifications) =>
    notifications.putOnce({
      id,
      sessionId,
      sender: "task",
      delivery: "wake",
      payload: {
        _tag: "TaskStatus",
        taskId: `task-of-${id}`,
        parentRunId: "parent-run",
        kind: "completed",
        summary,
        detail: {},
      },
    }),
  );

/** The user turn a conversation's run starts from. */
const userTurn = (text: string) => [{ role: "user" as const, content: text }];

testAgent()(function (it) {
  it.effect("a run is told the waiting status change and delivers it when it finishes", () =>
    Effect.gen(function* () {
      const session = yield* conversation;
      const id = `${session.id}:change`;
      const summary = "하위 작업이 끝났다";
      yield* leaveChange(session.id, id, summary);
      const runId = `${session.id}:run`;
      yield* scriptedRun({
        runId,
        turns: [{ text: "확인." }],
        threadId: session.id,
        conversation: userTurn("이어서 진행해 줘."),
        hooks: [(yield* told).hookFor(session.id, runId)],
      });

      const stored = yield* (yield* RunStore).thread(session.id);
      const toldMessage = stored.find(
        (message): message is Extract<typeof message, { readonly role: "user" }> =>
          message.role === "user" && message.orchestrator !== undefined,
      );
      expect(messageText(toldMessage!)).toContain(summary);
      expect(toldMessage?.toldNotifications).toEqual([id]);
      // The run finished, so it delivered the change its conversation tells.
      expect(yield* changeRow(id)).toEqual({ state: "delivered", delivered_run_id: runId });
    }),
  );

  it.effect(
    "a run whose model call fails leaves the change in the conversation, and the next run hears it without being told again",
    () =>
      Effect.gen(function* () {
        const session = yield* conversation;
        const id = `${session.id}:change`;
        const summary = "한 번만 넣을 상태 변화";
        yield* leaveChange(session.id, id, summary);
        const runId = `${session.id}:run`;
        yield* scriptedRun({
          runId,
          turns: [{ failAfterText: "모델이 실패했습니다." }],
          threadId: session.id,
          conversation: userTurn("이어서 진행해 줘."),
          hooks: [(yield* told).hookFor(session.id, runId)],
        });
        // The model did not answer, so the row still waits.
        expect(yield* changeRow(id)).toEqual({ state: "waiting", delivered_run_id: null });
        // The failed run saved the message that tells the change.
        const stored = yield* (yield* RunStore).thread(session.id);
        expect(stored.filter(tells(summary))).toHaveLength(1);
        const nextRunId = `${session.id}:next`;
        const next = yield* scriptedRun({
          runId: nextRunId,
          turns: [{ text: "확인했습니다." }],
          threadId: session.id,
          conversation: [...stored, { role: "user", content: "다시 해 줘." }],
          hooks: [(yield* told).hookFor(session.id, nextRunId)],
        });
        // The next run sends the saved message and is not given the change as a new one.
        const invocations = yield* next.invocations;
        expect(invocations).toHaveLength(1);
        expect(invocations[0]!.history.filter(tells(summary))).toHaveLength(1);
        expect(yield* changeRow(id)).toEqual({ state: "delivered", delivered_run_id: nextRunId });
      }),
  );

  it.effect("a run that fails after the model answered keeps the change delivered", () =>
    Effect.gen(function* () {
      const session = yield* conversation;
      const id = `${session.id}:change`;
      yield* leaveChange(session.id, id, "답한 뒤 실패");
      const runId = `${session.id}:run`;
      yield* scriptedRun({
        runId,
        turns: [
          { toolCalls: [{ id: "call-1", name: "find_memory", arguments: '{"query":"결정"}' }] },
          { failAfterText: "둘째 단계에서 실패." },
        ],
        threadId: session.id,
        conversation: userTurn("이어서 진행해 줘."),
        hooks: [(yield* told).hookFor(session.id, runId)],
      });
      expect(yield* changeRow(id)).toEqual({ state: "delivered", delivered_run_id: runId });
    }),
  );
});
