import { Cause, Deferred, Effect, Fiber, HashSet, Match, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { RunStore } from "../../src/loop/store.ts";
import type { JsonValue } from "../../src/json.ts";
import { messageText } from "../../src/agent/compaction.ts";
import { Subagents } from "../../src/subagents/subagents.ts";
import type { ScriptedInvocation, ScriptedTurn } from "../../src/testing/scripted-model.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { joinedNotice, selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import {
  current,
  encodeJson,
  freshSession,
  heldDefaultTurn,
  heldTurns,
  send,
  settled,
  until,
} from "./agent-env.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";

const Ids = Schema.Struct({ taskId: Schema.String, attemptId: Schema.String });
const Receipt = Schema.Struct({
  ...Ids.fields,
  status: Schema.Literal("running"),
  subagentId: Schema.String,
});
const Report = Schema.Struct({
  ...Ids.fields,
  status: Schema.String,
  answer: Schema.String,
});
const Count = Schema.Struct({ count: Schema.Finite });
const RunSpans = Schema.Array(
  Schema.Struct({ started_at: Schema.Finite, finished_at: Schema.Finite }),
);

/** The JSON object an answer ends with: the tool result the model echoed back. */
const jsonTail = (answer: string) => answer.slice(answer.indexOf("{"));
const receiptFrom = (answer: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Receipt))(jsonTail(answer));
/** The one report a get_subagent_reports call for a single attempt returned. */
const reportFrom = (answer: string) =>
  Effect.map(
    Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ reports: Schema.Tuple([Report]) })))(
      jsonTail(answer),
    ),
    ({ reports: [report] }) => report,
  );
const idsOf = ({ taskId, attemptId }: typeof Ids.Type) => ({ taskId, attemptId });
/** get_subagent_reports for one attempt, as the model calls it. */
const oneAttempt = (ids: typeof Ids.Type) => ({ attempts: [idsOf(ids)] });

const toolCall = (id: string, name: string, args: JsonValue) =>
  Effect.map(encodeJson(args), (json): ScriptedTurn => ({
    toolCalls: [{ id, name, arguments: json }],
  }));

const followUpPrompt = "This is an automatic task completion follow-up";

/** Holds the parent's second step of "delegate and get told" until the test lets it answer. */
const toldGate = Deferred.makeUnsafe<void>();

/** The parent's own scripted moves for the asynchronous contract; everything else is default. */
const asyncTurn = Effect.fnUntraced(
  function* (invocation: ScriptedInvocation) {
    const read = invocation.history.filter((message) => !joinedNotice(message));
    const user = messageText(
      read.findLast((message) => message.role === "user") ?? {
        role: "user",
        content: "",
      },
    );
    const internal = user.includes(followUpPrompt);
    const last = read.at(-1);
    const lastTool = last?.role === "tool" ? last.toolCallId : undefined;
    if (!internal && user.startsWith("review-batch "))
      return yield* Match.value(lastTool).pipe(
        Match.when("call-review-batch", () =>
          Effect.flatMap(
            Schema.decodeEffect(
              Schema.fromJsonString(Schema.Struct({ reports: Schema.Array(Report) })),
            )(messageText(last!)),
            ({ reports }) => Effect.map(encodeJson(reports.map(idsOf)), (text) => ({ text })),
          ),
        ),
        Match.orElse(() =>
          Effect.flatMap(
            Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Ids)))(
              user.slice("review-batch ".length),
            ),
            (attempts) => toolCall("call-review-batch", "get_subagent_reports", { attempts }),
          ),
        ),
      );
    if (!internal && user === "delegate and keep working")
      return yield* Match.value(lastTool).pipe(
        Match.when("call-background", () =>
          Effect.andThen(
            receiptFrom(messageText(last!)),
            toolCall("call-independent-work", "find_memory", { query: "SQLite 결정" }),
          ),
        ),
        Match.when("call-independent-work", () =>
          Effect.succeed({ text: "Independent parent work finished." }),
        ),
        Match.orElse(() => toolCall("call-background", "run_subagent", { task: "nap background" })),
      );
    if (!internal && user === "delegate and get told")
      return yield* Match.value(lastTool).pipe(
        Match.when("call-told-dispatch", () =>
          Effect.map(
            toolCall("call-told-work", "find_memory", { query: "SQLite 결정" }),
            (turn): ScriptedTurn => ({ ...turn, waitFor: Deferred.await(toldGate) }),
          ),
        ),
        Match.when("call-told-work", () => Effect.succeed({ text: "Told while working." })),
        Match.orElse(() => toolCall("call-told-dispatch", "run_subagent", { task: "nap told" })),
      );
    if (!internal && user.startsWith("dispatch only resume ") && lastTool === undefined)
      return {
        toolCalls: [
          {
            id: "call-resume_subagent",
            name: "resume_subagent",
            arguments: user.slice("dispatch only resume ".length),
          },
        ],
      };
    return yield* heldDefaultTurn(invocation);
  },
  Effect.mapError((cause) => new Cause.UnknownError(cause)),
);

const testProvider = { responder: asyncTurn };

/** A parent session with the test model chosen, and the test's held model turns. */
const parentSession = Effect.gen(function* () {
  yield* current(selectTestModel());
  return { sessionId: yield* freshSession, turns: yield* heldTurns };
});

const callTool = Effect.fnUntraced(function* (sessionId: string, name: string, args: JsonValue) {
  return yield* send(sessionId, `call ${name} ${yield* encodeJson(args)}`);
});

const count = (query: string, ...params: string[]) =>
  Effect.map(
    Effect.flatMap(sqlGet(query, ...params), Schema.decodeUnknownEffect(Count)),
    (row) => row.count,
  );

const runningRuns = (sessionId: string) =>
  count(
    "SELECT count(*) AS count FROM chat_runs WHERE thread_id = ? AND status = 'running'",
    sessionId,
  );

const deliveredCompletions = (sessionId: string) =>
  count(
    `SELECT count(*) AS count FROM parent_notifications
     WHERE origin_session_id = ? AND kind = 'completed' AND delivered_at IS NOT NULL`,
    sessionId,
  );

const userNodes = (sessionId: string) =>
  count("SELECT count(*) AS count FROM nodes WHERE session_id = ? AND kind = 'user'", sessionId);

/** Whether the model was asked for the session's automatic follow-up. */
const followedUp = Effect.fnUntraced(function* (sessionId: string) {
  const { provider } = yield* TestEnv;
  return () =>
    provider!.invocations.some(
      (invocation) =>
        invocation.run.threadId === sessionId &&
        invocation.history.some(
          (message) => message.role === "user" && messageText(message).includes(followUpPrompt),
        ),
    );
});

// The restart tests replace the block's agent, so every test reads services through `current`
// instead of the block's layer, and all of them share one agent.
testAgent({ testProvider })("asynchronous subagents", (it) => {
  it.effect("batch retrieval returns every requested attempt's report in one call", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const first = yield* receiptFrom(
        yield* send(sessionId, 'call run_subagent {"task":"nap first dispatch only"}'),
      );
      const second = yield* receiptFrom(
        yield* send(sessionId, 'call run_subagent {"task":"nap second dispatch only"}'),
      );
      yield* turns.release("nap", 2);
      const attempts = [idsOf(first), idsOf(second)];
      yield* settled(sessionId);
      expect(yield* send(sessionId, `review-batch ${yield* encodeJson(attempts)}`)).toBe(
        yield* encodeJson(attempts),
      );
    }),
  );

  it.effect(
    "the parent executes independent tools in the same turn before the child finishes",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* TestEnv;
        const { sessionId, turns } = yield* parentSession;
        const children = yield* current(Subagents);
        expect(yield* send(sessionId, "delegate and keep working")).toBe(
          "Independent parent work finished.",
        );
        expect((yield* children.list(sessionId))[0]?.status).toBe("running");
        expect(
          provider!.invocations.some(
            (invocation) =>
              invocation.run.threadId === sessionId &&
              invocation.history.some(
                (message) =>
                  message.role === "tool" && message.toolCallId === "call-independent-work",
              ),
          ),
        ).toBe(true);
        yield* turns.release("nap");
        yield* until(
          Effect.zipWith(
            children.list(sessionId),
            runningRuns(sessionId),
            (listed, running) => listed[0]?.status === "completed" && running === 0,
          ),
          "child finishes after parent work",
        );
      }),
  );

  it.effect("a task that ends while the run works is told in a message that joins the run", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestEnv;
      const { sessionId, turns } = yield* parentSession;
      const children = yield* current(Subagents);
      const parent = yield* Effect.forkChild(send(sessionId, "delegate and get told"), {
        startImmediately: true,
      });
      yield* turns.release("nap told");
      yield* until(
        Effect.zipWith(
          children.list(sessionId),
          count(
            `SELECT count(*) AS count FROM parent_notifications
             WHERE origin_session_id = ? AND delivered_at IS NULL`,
            sessionId,
          ),
          (listed, pending) => listed[0]?.status === "completed" && pending === 1,
        ),
        "the child's end while the parent works",
      );
      yield* Deferred.succeed(toldGate, undefined);
      expect(yield* Fiber.join(parent)).toBe("Told while working.");
      const notices = (yield* (yield* current(RunStore)).thread(sessionId)).filter(joinedNotice);
      expect(notices.map((message) => message.role === "user" && message.orchestrator)).toEqual([
        { next: "run", ended: { background: 0, subagent: 1 } },
      ]);
      // Every request of the run kept the same system prompt.
      const systems = provider!.invocations
        .filter((invocation) => invocation.run.threadId === sessionId)
        .map((invocation) => invocation.system.join("\n"));
      expect(HashSet.size(HashSet.fromIterable(systems))).toBe(1);
    }),
  );

  it.effect(
    "immediate receipt, parent-end survival, and durable idle follow-up without a synthetic user",
    () =>
      Effect.gen(function* () {
        const { sessionId, turns } = yield* parentSession;
        const children = yield* current(Subagents);
        yield* receiptFrom(yield* send(sessionId, "dispatch only"));
        expect((yield* children.list(sessionId))[0]?.status).toBe("running");
        expect(yield* send(sessionId, "unrelated parent work")).toContain("Hello");
        yield* turns.release("nap");
        yield* until(
          Effect.map(children.list(sessionId), (listed) => listed[0]?.status === "completed"),
          "child survives parent end",
        );
        const followUp = yield* followedUp(sessionId);
        yield* until(
          Effect.map(runningRuns(sessionId), (running) => followUp() && running === 0),
          "idle follow-up",
        );
        expect(yield* deliveredCompletions(sessionId)).toBe(1);
        expect(yield* userNodes(sessionId)).toBe(2);
        const messages = yield* (yield* current(RunStore)).thread(sessionId);
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" &&
              messageText(message).includes("Background work completed"),
          ),
        ).toBe(true);
        // The orchestrator's message started the follow-up; no user turn was made up for it.
        expect(
          messages.filter(
            (message) => message.role === "user" && message.orchestrator === undefined,
          ),
        ).toHaveLength(2);
        expect(
          messages.flatMap((message) =>
            message.role === "user" && message.orchestrator !== undefined
              ? [message.orchestrator]
              : [],
          ),
        ).toEqual([{ next: "results", ended: { background: 0, subagent: 1 } }]);
      }),
  );

  it.effect("concurrent children cannot cause overlapping parent turns", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const children = yield* current(Subagents);
      const answer = yield* send(sessionId, "delegate twice dispatch only");
      expect(answer.match(/"status":"running"/g)).toHaveLength(2);
      expect((yield* children.list(sessionId)).map((child) => child.status)).toEqual([
        "running",
        "running",
      ]);
      const parent = yield* Effect.forkChild(send(sessionId, "slow parent work"), {
        startImmediately: true,
      });
      // The held model turn proves the parent is actually answering.
      yield* turns.waitFor("slow parent work");
      yield* turns.release("nap", 2);
      yield* until(
        Effect.map(children.list(sessionId), (listed) =>
          listed.every((child) => child.status === "completed"),
        ),
        "both children finish",
      );
      expect(yield* runningRuns(sessionId)).toBe(1);
      expect((yield* followedUp(sessionId))()).toBe(false);
      yield* turns.release("slow parent work");
      yield* Fiber.join(parent);
      yield* until(
        Effect.zipWith(
          deliveredCompletions(sessionId),
          runningRuns(sessionId),
          (delivered, running) => delivered === 2 && running === 0,
        ),
        "post-parent notification",
      );
      const runs = yield* Schema.decodeUnknownEffect(RunSpans)(
        yield* sqlAll(
          "SELECT started_at, finished_at FROM chat_runs WHERE thread_id = ? ORDER BY started_at",
          sessionId,
        ),
      );
      runs.slice(1).forEach((run, index) => {
        expect(run.started_at).toBeGreaterThanOrEqual(runs[index]!.finished_at);
      });
      expect(yield* userNodes(sessionId)).toBe(2);
    }),
  );

  it.effect("an unfinished attempt reports running until it completes", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const ids = idsOf(yield* receiptFrom(yield* send(sessionId, "dispatch only")));
      expect(yield* callTool(sessionId, "get_subagent_reports", oneAttempt(ids))).toContain(
        '"status":"running"',
      );
      yield* turns.release("nap");
      yield* settled(sessionId);
      const report = yield* reportFrom(
        yield* callTool(sessionId, "get_subagent_reports", oneAttempt(ids)),
      );
      expect(report.status).toBe("completed");
    }),
  );

  it.effect("cancel reaches an approval-waiting child after its parent ended", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession;
      const children = yield* current(Subagents);
      const trace = yield* current(WorkTraceStore);
      const receipt = yield* receiptFrom(
        yield* send(sessionId, 'call run_subagent {"task":"shell: printf dispatch only"}'),
      );
      yield* until(
        Effect.map(
          trace.taskDetail(sessionId, receipt.taskId),
          (detail) => detail?.attempts[0]?.status === "waiting",
        ),
        "child approval wait",
      );
      const agent = yield* current(AgentChat);
      yield* agent.cancel(sessionId, null);
      expect((yield* children.list(sessionId))[0]?.status).toBe("cancelled");
      expect((yield* trace.taskDetail(sessionId, receipt.taskId))?.attempts[0]?.status).toBe(
        "cancelled",
      );
      expect(
        yield* count(
          `SELECT count(*) AS count FROM run_events
           WHERE task_id = ? AND kind = 'tool_completed'`,
          receipt.taskId,
        ),
      ).toBe(0);
      // Follow-ups start only from notifications the session does not hold; cancel holds them.
      expect(yield* trace.pendingParentNotificationSessions).not.toContain(sessionId);
      expect((yield* agent.status(sessionId, null)).running).toBeNull();
      expect(
        yield* count("SELECT count(*) AS count FROM chat_runs WHERE thread_id = ?", sessionId),
      ).toBe(1);
    }),
  );

  it.effect("queued named attempts cancel separately and reports use exact attempts", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const children = yield* current(Subagents);
      const trace = yield* current(WorkTraceStore);
      const first = yield* receiptFrom(
        yield* send(
          sessionId,
          'call run_subagent {"agent":"helper","task":"nap first dispatch only"}',
        ),
      );
      const second = yield* receiptFrom(
        yield* send(
          sessionId,
          'call run_subagent {"agent":"helper","task":"nap queued dispatch only"}',
        ),
      );
      expect(first.subagentId).toBe(second.subagentId);
      expect(first.attemptId).not.toBe(second.attemptId);
      expect(yield* children.stopTask(second.taskId)).toBe("stopped");
      expect((yield* trace.taskDetail(sessionId, second.taskId))?.attempts[0]?.status).toBe(
        "cancelled",
      );
      expect((yield* trace.taskDetail(sessionId, first.taskId))?.attempts[0]?.status).toBe(
        "running",
      );
      yield* turns.release("nap first");
      yield* settled(sessionId);
      const firstReport = yield* reportFrom(
        yield* callTool(sessionId, "get_subagent_reports", oneAttempt(first)),
      );
      const secondReport = yield* reportFrom(
        yield* callTool(sessionId, "get_subagent_reports", oneAttempt(second)),
      );
      expect(firstReport.answer).toContain("nap first");
      expect(secondReport.status).toBe("cancelled");
      expect(secondReport.answer).toBe("");
    }),
  );

  it.effect("resume returns a new running attempt receipt without awaiting its report", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const children = yield* current(Subagents);
      const first = yield* receiptFrom(yield* send(sessionId, "dispatch only"));
      yield* turns.release("nap");
      yield* settled(sessionId);
      yield* sqlRun(
        "UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?",
        first.attemptId,
      );
      yield* sqlRun(
        "UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?",
        first.taskId,
      );
      const resumed = yield* receiptFrom(
        yield* send(
          sessionId,
          `dispatch only resume ${yield* encodeJson({ taskId: first.taskId, expectedAttemptId: first.attemptId })}`,
        ),
      );
      expect(resumed.taskId).toBe(first.taskId);
      expect(resumed.attemptId).not.toBe(first.attemptId);
      expect((yield* children.list(sessionId))[0]?.status).toBe("running");
      yield* turns.release("nap");
      yield* settled(sessionId);
    }),
  );

  it.effect("reports survive restart and incomplete notification deliveries are replayable", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId, turns } = yield* parentSession;
      const trace = yield* current(WorkTraceStore);
      const receipt = yield* receiptFrom(yield* send(sessionId, "dispatch only"));
      yield* turns.release("nap");
      yield* settled(sessionId);
      const before = yield* reportFrom(
        yield* callTool(sessionId, "get_subagent_reports", oneAttempt(receipt)),
      );
      const notificationId = yield* trace.notifyParent({
        taskId: receipt.taskId,
        kind: "completed",
        summary: "Undelivered after crash",
        idempotencyKey: `${sessionId}:crash-delivery`,
      });
      expect(
        (yield* trace.consumeParentNotifications(
          sessionId,
          `${sessionId}:crashed-before-run-persisted`,
        )).map((entry) => entry.id),
      ).toContain(notificationId);
      yield* env.reopen;
      expect(
        (yield* (yield* env.use(WorkTraceStore)).consumeParentNotifications(
          sessionId,
          `${sessionId}:retry-parent`,
        )).map((entry) => entry.id),
      ).toContain(notificationId);
      expect(
        yield* reportFrom(yield* callTool(sessionId, "get_subagent_reports", oneAttempt(receipt))),
      ).toEqual(before);
    }),
  );

  it.effect("a held parent notification stays out of automatic follow-up after restart", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId } = yield* parentSession;
      const trace = yield* current(WorkTraceStore);
      const receipt = yield* receiptFrom(yield* send(sessionId, "dispatch only"));
      yield* trace.holdParentNotifications(sessionId);
      const notificationId = yield* trace.notifyParent({
        taskId: receipt.taskId,
        kind: "completed",
        summary: "Wait for an explicit user turn",
        idempotencyKey: `${sessionId}:held-notification`,
      });
      expect(notificationId).not.toBeNull();
      expect(yield* trace.pendingParentNotificationSessions).not.toContain(sessionId);
      yield* env.reopen;
      const reopened = yield* env.use(WorkTraceStore);
      expect(yield* reopened.parentNotificationsHeld(sessionId)).toBe(true);
      expect(yield* reopened.pendingParentNotificationSessions).not.toContain(sessionId);
      yield* reopened.resumeParentNotifications(sessionId);
      expect(yield* reopened.pendingParentNotificationSessions).toContain(sessionId);
    }),
  );

  it.effect("service disposal aborts background children and records them cancelled", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId } = yield* parentSession;
      const receipt = yield* receiptFrom(yield* send(sessionId, "dispatch only"));
      yield* env.reopen;
      const detail = yield* (yield* env.use(WorkTraceStore)).taskDetail(sessionId, receipt.taskId);
      expect(detail?.attempts[0]?.status).toBe("cancelled");
    }),
  );
});
