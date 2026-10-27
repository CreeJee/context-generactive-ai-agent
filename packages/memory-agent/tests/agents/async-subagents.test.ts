import { Cause, Effect, Fiber, HashSet, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { RunStore } from "../../src/loop/store.ts";
import type { JsonValue } from "../../src/json.ts";
import { StepEnded } from "../../src/loop/run.ts";
import { RunEnd } from "../../src/loop/store.ts";
import { messageText } from "../../src/agent/compaction.ts";
import { Subagents } from "../../src/subagents/subagents.ts";
import type { ScriptedInvocation, ScriptedTurn } from "../../src/testing/scripted-model.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { selectTestModel } from "../support/provider.ts";
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

/** The parent's own scripted moves for the asynchronous contract; everything else is default. */
const asyncTurn = Effect.fnUntraced(
  function* (invocation: ScriptedInvocation) {
    const user = messageText(
      invocation.history.findLast((message) => message.role === "user") ?? {
        role: "user",
        content: "",
      },
    );
    const internal = invocation.system.some((prompt) => prompt.includes(followUpPrompt));
    const last = invocation.history.at(-1);
    const lastTool = last?.role === "tool" ? last.toolCallId : undefined;
    if (!internal && user.startsWith("review-batch ")) {
      switch (lastTool) {
        case "call-review-batch": {
          const { reports } = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ reports: Schema.Array(Report) })),
          )(messageText(last!));
          return yield* toolCall("call-adopt-batch", "adopt_subagent_reports", {
            reports: reports.map(idsOf),
          });
        }
        case "call-adopt-batch":
          return { text: "Used both reviewed reports." };
        default:
          return yield* toolCall("call-review-batch", "get_subagent_reports", {
            attempts: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Ids)))(
              user.slice("review-batch ".length),
            ),
          });
      }
    }
    if (!internal && user === "delegate and keep working") {
      switch (lastTool) {
        case "call-background":
          yield* receiptFrom(messageText(last!));
          return yield* toolCall("call-independent-work", "find_memory", { query: "SQLite 결정" });
        case "call-independent-work":
          return { text: "Independent parent work finished." };
        default:
          return yield* toolCall("call-background", "run_subagent", { task: "nap background" });
      }
    }
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
    if (!internal && user.startsWith("review-and-adopt ")) {
      const ids = yield* Schema.decodeEffect(Schema.fromJsonString(Ids))(
        user.slice("review-and-adopt ".length),
      );
      switch (lastTool) {
        case "call-review-report": {
          yield* reportFrom(messageText(last!));
          return yield* toolCall("call-adopt-report", "adopt_subagent_reports", {
            reports: [ids],
          });
        }
        case "call-adopt-report":
          return { text: "Used the reviewed report." };
        default:
          return yield* toolCall("call-review-report", "get_subagent_reports", oneAttempt(ids));
      }
    }
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
        invocation.system.some((prompt) => prompt.includes(followUpPrompt)),
    );
});

testAgent({ testProvider })("asynchronous subagents", (it) => {
  it.effect("batch retrieval reviews each attempt for adoption in the same run", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const trace = yield* WorkTraceStore;
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
        "Used both reviewed reports.",
      );
      for (const attempt of attempts)
        expect(
          (yield* trace.taskDetail(sessionId, attempt.taskId))?.answerClaims.flatMap(
            (claim) => claim.sources,
          ),
        ).toContainEqual(attempt);
    }),
  );

  it.effect(
    "the parent executes independent tools in the same turn before the child finishes",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* TestEnv;
        const { sessionId, turns } = yield* parentSession;
        const children = yield* Subagents;
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

  it.effect(
    "immediate receipt, parent-end survival, and durable idle follow-up without a synthetic user",
    () =>
      Effect.gen(function* () {
        const { sessionId, turns } = yield* parentSession;
        const children = yield* Subagents;
        const trace = yield* WorkTraceStore;
        const receipt = yield* receiptFrom(yield* send(sessionId, "dispatch only"));
        expect((yield* children.list(sessionId))[0]?.status).toBe("running");
        expect((yield* trace.taskDetail(sessionId, receipt.taskId))?.answerClaims).toEqual([]);
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
        expect((yield* trace.taskDetail(sessionId, receipt.taskId))?.answerClaims).toEqual([]);
        const messages = yield* (yield* RunStore).thread(sessionId);
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" &&
              messageText(message).includes("Background work completed"),
          ),
        ).toBe(true);
        expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
      }),
  );

  it.effect("concurrent children cannot cause overlapping parent turns", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const children = yield* Subagents;
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
      for (let index = 1; index < runs.length; index++)
        expect(runs[index]!.started_at).toBeGreaterThanOrEqual(runs[index - 1]!.finished_at);
      expect(yield* userNodes(sessionId)).toBe(2);
    }),
  );

  it.effect("adoption requires retrieval in the same run", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const trace = yield* WorkTraceStore;
      const ids = idsOf(yield* receiptFrom(yield* send(sessionId, "dispatch only")));
      expect(yield* callTool(sessionId, "get_subagent_reports", oneAttempt(ids))).toContain(
        '"status":"running"',
      );
      yield* turns.release("nap");
      // The completion follow-up retrieves the report in a run of its own.
      yield* settled(sessionId);
      expect((yield* trace.taskDetail(sessionId, ids.taskId))?.answerClaims).toEqual([]);
      const adopt = callTool(sessionId, "adopt_subagent_reports", {
        reports: [ids],
      });
      expect(yield* adopt).toContain("Only reports reviewed in this run");
      expect(yield* send(sessionId, `review-and-adopt ${yield* encodeJson(ids)}`)).toContain(
        "Used the reviewed report",
      );
      expect((yield* trace.taskDetail(sessionId, ids.taskId))?.answerClaims).toHaveLength(1);
      expect(yield* adopt).toContain("Only reports reviewed in this run");
    }),
  );

  it.effect("adoption is gated on reports reviewed in the same run", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const { project } = yield* TestEnv;
      const children = yield* Subagents;
      const trace = yield* WorkTraceStore;
      const binding = {
        project,
        sessionId,
        runId: "run-effect-ai",
        selection: yield* current(selectTestModel()),
        abortSignal: yield* Effect.abortSignal,
        tools: [],
        systemPrompts: [],
        deliveredParentNotificationIds: HashSet.empty<string>(),
        gated: HashSet.empty<string>(),
      };
      const { tools, hook } = yield* children.runToolsFor(binding);
      const [run, , reports, adopt] = tools;
      const call = (tool: RunTool | undefined, params: JsonValue) =>
        Effect.fromNullishOr(tool).pipe(
          Effect.flatMap((found) => found.prepare(params)),
          Effect.flatMap((prepared) => prepared({ toolCallId: "call-1" })),
        );
      const ids = idsOf(
        yield* Effect.flatMap(
          call(run, { task: "nap effect ai dispatch only" }),
          Schema.decodeUnknownEffect(Receipt),
        ),
      );
      expect(yield* Effect.flip(call(adopt, { reports: [ids] }))).toMatchObject({
        message: expect.stringContaining("Only reports reviewed in this run"),
      });
      yield* turns.release("nap");
      // No page holds this session, so no follow-up run takes the completion notification.
      yield* until(
        Effect.map(children.list(sessionId), (listed) => listed[0]?.status === "completed"),
        "the child to finish",
      );
      expect(yield* call(reports, oneAttempt(ids))).toMatchObject({
        reports: [{ status: "completed" }],
      });
      expect(yield* call(adopt, { reports: [ids] })).toEqual({
        status: "recorded",
        usedReportCount: 1,
        reflectedNotificationCount: 0,
      });
      // The run's answer ends it, so the adoption is recorded under that message.
      const { stepEnded, ended } = yield* hook;
      const scope = { threadId: sessionId, runId: binding.runId, emit: () => Effect.void };
      const answer = { role: "assistant" as const, id: "message-1", content: "done" };
      yield* stepEnded!(scope, StepEnded.Model({ message: answer, answered: [] }));
      yield* ended!(scope, RunEnd.Completed(), [answer]);
      expect(
        (yield* trace.taskDetail(sessionId, ids.taskId))?.answerClaims.flatMap(
          (claim) => claim.sources,
        ),
      ).toEqual([ids]);
    }),
  );

  it.effect("cancel reaches an approval-waiting child after its parent ended", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession;
      const children = yield* Subagents;
      const trace = yield* WorkTraceStore;
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
      expect((yield* (yield* AgentChat).cancel(sessionId, null)).status).toBe(200);
      expect((yield* children.list(sessionId))[0]?.status).toBe("cancelled");
      expect(
        yield* count(
          `SELECT count(*) AS count FROM run_events
           WHERE task_id = ? AND kind = 'tool_completed'`,
          receipt.taskId,
        ),
      ).toBe(0);
      // Nothing signals that a follow-up was not started, so give one a moment to appear.
      yield* Effect.sleep("100 millis");
      expect(
        yield* count("SELECT count(*) AS count FROM chat_runs WHERE thread_id = ?", sessionId),
      ).toBe(1);
    }),
  );

  it.effect("queued named attempts cancel separately and reports use exact attempts", () =>
    Effect.gen(function* () {
      const { sessionId, turns } = yield* parentSession;
      const children = yield* Subagents;
      const trace = yield* WorkTraceStore;
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
      const children = yield* Subagents;
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
});

// Reopening replaces the block's agent, so each restart test has a block of its own and reads
// services through `env.use` once it has reopened.
testAgent({ testProvider })("subagent reports across restart", (it) => {
  it.effect("reports survive restart and incomplete notification deliveries are replayable", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId, turns } = yield* parentSession;
      const trace = yield* WorkTraceStore;
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
});

testAgent({ testProvider })("held parent notifications across restart", (it) => {
  it.effect("a held parent notification stays out of automatic follow-up after restart", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId } = yield* parentSession;
      const trace = yield* WorkTraceStore;
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
});

testAgent({ testProvider })("background children when the agent closes", (it) => {
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
