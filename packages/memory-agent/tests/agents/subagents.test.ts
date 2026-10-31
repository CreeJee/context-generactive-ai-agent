import { Effect, Fiber, FileSystem, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { RelayedApprovals } from "../../src/approvals/relayed.ts";
import { ApprovalRequester } from "../../src/approvals/relayed-state.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import type { PermissionMode } from "../../src/projects/projects.ts";
import { Subagents, subagentThreadId } from "../../src/subagents/subagents.ts";
import { ResumeRequest } from "../../src/work-trace/store.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import {
  current,
  delegate,
  encodeJson,
  freshProject,
  heldDefaultTurn,
  heldTurns,
  sdk,
  send,
  settled,
  until,
} from "./agent-env.ts";
import { sqlAll, sqlGet, sqlRun, sqlTransaction } from "../support/sql.ts";

const TraceSummary = Schema.Struct({
  task_id: Schema.String,
  attempt_id: Schema.String,
  task_status: Schema.String,
  attempt_status: Schema.String,
  parent_run_id: Schema.String,
  parent_tool_call_id: Schema.String,
  chat_run_id: Schema.String,
  event_kinds: Schema.String,
});
const ResumeIds = Schema.Struct({ task_id: Schema.String, attempt_id: Schema.String });
const ResumeResult = Schema.Struct({ attempts: Schema.Finite, latest_status: Schema.String });
const ArtifactSummary = Schema.Struct({ kind: Schema.String, locator: Schema.String });
const RestartedTrace = Schema.Struct({
  attempt_status: Schema.String,
  task_status: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  resume_reason: Schema.NullOr(Schema.String),
});

/** A parent session in a project of its own, with the test model chosen. */
const parentSession = Effect.fnUntraced(function* (mode: PermissionMode = "ask") {
  yield* current(selectTestModel());
  return yield* freshProject(mode);
});

/** The latest child attempt started from the session. */
const latestAttempt = (sessionId: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(ResumeIds)(
      yield* sqlGet(
        `SELECT t.id AS task_id, a.id AS attempt_id
         FROM work_tasks t JOIN agent_run_attempts a ON a.task_id = t.id
         WHERE t.origin_session_id = ? ORDER BY a.created_at DESC LIMIT 1`,
        sessionId,
      ),
    );
  });

testAgent({ testProvider: { responder: heldDefaultTurn } })("subagents", (it) => {
  it.effect(
    "a one-off child gets only the task, the parent's tools minus subagents, and reports back",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* TestEnv;
        const { project, sessionId } = yield* parentSession();
        const subagents = yield* Subagents;
        const chat = yield* AgentChat;
        yield* (yield* FileSystem.FileSystem).writeFileString(
          (yield* Path.Path).join(project.root, "AGENTS.md"),
          "ROOT INSTRUCTIONS FOR EVERY AGENT",
        );
        const answer = yield* delegate(sessionId, 'call run_subagent {"task":"list what matters"}');
        expect(answer).toContain("child done: list what matters (earlier user messages: 0)");
        expect(answer).toContain('"status":"completed"');
        const [child] = yield* subagents.list(sessionId);
        expect(child).toMatchObject({
          name: null,
          status: "completed",
          lastTask: "list what matters",
        });
        const invocations = provider!.invocations;
        const parentStart = invocations.find((invocation) => invocation.run.threadId === sessionId);
        const childStart = invocations.find(
          (invocation) => invocation.run.threadId === subagentThreadId(child!.id),
        );
        expect(parentStart?.system.join("\n")).toContain("You can delegate with run_subagent");
        expect(childStart?.system.join("\n")).toContain("You are a subagent");
        expect(parentStart?.toolNames).toContain("run_subagent");
        expect(parentStart?.system.join("\n")).toContain("ROOT INSTRUCTIONS FOR EVERY AGENT");
        expect(childStart?.system.join("\n")).toContain("ROOT INSTRUCTIONS FOR EVERY AGENT");
        // No nesting, and nothing the parent does not have.
        [
          "run_subagent",
          "update_goal",
          "update_plan",
          "update_workflow_progress",
          "record_workflow_blocker",
          "delegate_to_agent",
        ].forEach((tool) => {
          expect(childStart?.toolNames).not.toContain(tool);
        });
        expect(childStart?.system.some((prompt) => prompt.includes("Current workflow"))).toBe(
          false,
        );
        expect(childStart?.toolNames).toContain("read_subagent_tool_result");
        // The only child-specific tool reads bounded pages of that child's own persisted results.
        expect(
          childStart?.toolNames
            .filter((name) => name !== "read_subagent_tool_result")
            .every((name) => parentStart?.toolNames.includes(name)),
        ).toBe(true);
        // The parent's conversation is not copied into the child.
        expect(
          childStart?.history.some(
            (message) =>
              message.role === "user" &&
              Schema.is(Schema.String)(message.content) &&
              message.content.includes("call run_subagent"),
          ),
        ).toBe(false);
        const transcript = yield* subagents.transcript(sessionId, child!.id);
        expect(transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        const trace = yield* Schema.decodeUnknownEffect(TraceSummary)(
          yield* sqlGet(
            `SELECT t.id AS task_id, a.id AS attempt_id,
                  t.status AS task_status, a.status AS attempt_status,
                  t.parent_run_id, t.parent_tool_call_id, a.chat_run_id,
                  (SELECT group_concat(kind, ',') FROM run_events e
                   WHERE e.attempt_id = a.id ORDER BY e.attempt_sequence) AS event_kinds
               FROM work_tasks t
               JOIN agent_run_attempts a ON a.task_id = t.id
               WHERE t.agent_id = ?`,
            child!.id,
          ),
        );
        expect(trace).toMatchObject({ task_status: "completed", attempt_status: "completed" });
        expect(trace.parent_run_id).not.toBe("");
        expect(trace.parent_tool_call_id).not.toBe("");
        expect(trace.chat_run_id).not.toBe("");
        expect(trace.event_kinds.split(",")).toEqual([
          "attempt_queued",
          "attempt_started",
          "attempt_completed",
        ]);

        const tree = yield* chat.traceTree(sessionId);
        expect(tree.status).toBe(200);
        expect(yield* sdk(() => tree.text())).toContain(trace.task_id);
        const detailResponse = yield* chat.traceTask(sessionId, trace.task_id);
        expect(detailResponse.status).toBe(200);
        const detail = yield* sdk(() => detailResponse.text());
        expect(detail).toContain(trace.chat_run_id);
        expect(detail).toContain('"heartbeat":{"state":"idle","step":"Subagent completed"');
        const terminalResume = yield* chat.requestTraceResume(
          sessionId,
          null,
          trace.task_id,
          trace.attempt_id,
          false,
        );
        expect(terminalResume.status).toBe(409);
        expect(yield* sdk(() => terminalResume.json())).toEqual(
          ResumeRequest.blocked({ reason: "task_terminal" }),
        );
        yield* sqlTransaction(
          Effect.gen(function* () {
            yield* sqlRun(
              "UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?",
              trace.attempt_id,
            );
            yield* sqlRun(
              "UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?",
              trace.task_id,
            );
          }),
        );
        const queuedResume = yield* chat.requestTraceResume(
          sessionId,
          null,
          trace.task_id,
          trace.attempt_id,
          false,
        );
        expect(queuedResume.status).toBe(202);
        expect(yield* sdk(() => queuedResume.json())).toEqual(
          ResumeRequest.queued({ taskId: trace.task_id, expectedAttemptId: trace.attempt_id }),
        );
        const stream = yield* chat.traceStream(
          new Request("http://local/trace/stream?after=0"),
          sessionId,
        );
        expect(stream.headers.get("content-type")).toContain("text/event-stream");
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => stream.body!.getReader()),
          (reader) => Effect.promise(() => reader.cancel()),
        );
        const first = yield* sdk(() => reader.read());
        expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
        const invalidCursor = yield* chat.traceStream(
          new Request("http://local/trace/stream?after=nope"),
          sessionId,
        );
        expect(invalidCursor.status).toBe(400);
      }),
  );

  it.effect("subagent calls of one step run at the same time and answer in call order", () =>
    Effect.gen(function* () {
      const turns = yield* heldTurns;
      const { sessionId } = yield* parentSession();
      const pending = yield* Effect.forkChild(send(sessionId, "delegate twice"), {
        startImmediately: true,
      });
      // Both child model calls start while neither child can finish.
      yield* turns.waitFor("nap A");
      yield* turns.waitFor("nap B");
      yield* turns.release("nap", 2);
      const answer = yield* Fiber.join(pending);
      yield* settled(sessionId);
      const children = yield* (yield* Subagents).list(sessionId);
      expect(children.map((child) => child.status)).toEqual(["completed", "completed"]);
      const receiptOf = (task: string) =>
        answer.indexOf(children.find((child) => child.lastTask === task)!.id);
      expect(receiptOf("nap A")).toBeGreaterThan(-1);
      expect(receiptOf("nap A")).toBeLessThan(receiptOf("nap B"));
    }),
  );

  it.effect("a named child keeps its own conversation across the session's runs", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession();
      yield* delegate(sessionId, 'call run_subagent {"agent":"helper","task":"first task"}');
      const second = yield* delegate(
        sessionId,
        'call run_subagent {"agent":"helper","task":"second task"}',
      );
      expect(second).toContain("child done: second task (earlier user messages: 1)");
      const children = yield* (yield* Subagents).list(sessionId);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ name: "helper", lastTask: "second task" });
    }),
  );

  it.effect("a child's gated call waits for the user on the page, and a denial never runs it", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession("ask");
      const subagents = yield* Subagents;
      const relayed = yield* RelayedApprovals;
      const approved = yield* Effect.forkChild(
        delegate(sessionId, 'call run_subagent {"task":"shell: printf child-approved"}'),
      );
      yield* until(
        Effect.map(relayed.pending(sessionId), (pending) => pending.length === 1),
        "the child's approval",
      );
      const [request] = yield* relayed.pending(sessionId);
      expect(request).toMatchObject({ toolName: "save_code_skill", askedBy: "every_call" });
      expect(ApprovalRequester.guards.subagent(request!.requester)).toBe(true);
      expect(request!.requester).toMatchObject({ name: null });
      expect(yield* relayed.answer("another-session", request!.id, true)).toBe(false);
      expect(yield* relayed.answer(sessionId, request!.id, true)).toBe(true);
      const approvedAnswer = yield* Fiber.join(approved);
      expect(approvedAnswer).toContain("scriptSha256");
      const denied = yield* Effect.forkChild(
        delegate(sessionId, 'call run_subagent {"task":"shell: printf child-denied"}'),
      );
      yield* until(
        Effect.map(relayed.pending(sessionId), (pending) => pending.length === 1),
        "the second approval",
      );
      yield* relayed.answer(sessionId, (yield* relayed.pending(sessionId))[0]!.id, false);
      const deniedAnswer = yield* Fiber.join(denied);
      expect(deniedAnswer).toContain("User denied this action");
      expect(deniedAnswer).not.toContain("scriptSha256");
      const reviews = yield* PermissionReviews;
      const children = yield* subagents.list(sessionId);
      expect(
        (yield* reviews.latest(sessionId, `subagent-${children[0]!.id}:call-shell`))?.decision,
      ).toBe("approved");
      expect(
        (yield* reviews.latest(sessionId, `subagent-${children[1]!.id}:call-shell`))?.decision,
      ).toBe("denied");
      // Both calls ended: the approved one settled, the denied one never started.
      yield* Effect.forEach(
        children,
        Effect.fnUntraced(function* (child) {
          expect(
            yield* sqlGet(
              `SELECT a.pending_tool_call_ids FROM agent_run_attempts a
               JOIN work_tasks t ON t.id = a.task_id WHERE t.agent_id = ?`,
              child.id,
            ),
          ).toEqual({ pending_tool_call_ids: "[]" });
        }),
        { discard: true },
      );
    }),
  );

  it.effect("a child file write records the actual artifact without copying its contents", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession("full");
      const answer = yield* delegate(
        sessionId,
        'call run_subagent {"task":"call write_file {\\"path\\":\\"wt-artifact.txt\\",\\"content\\":\\"artifact sentinel body\\"}"}',
      );
      expect(answer).toContain("write_file said");
      const artifact = yield* Schema.decodeUnknownEffect(ArtifactSummary)(
        yield* sqlGet(
          `SELECT w.kind, w.locator FROM work_artifacts w
             JOIN work_tasks t ON t.id = w.task_id
             WHERE t.agent_id = ?`,
          (yield* (yield* Subagents).list(sessionId))[0]!.id,
        ),
      );
      expect(artifact.kind).toBe("file");
      expect(artifact.locator).toContain('"path":"wt-artifact.txt"');
      expect(yield* encodeJson(yield* sqlAll("SELECT * FROM work_artifacts"))).not.toContain(
        "artifact sentinel body",
      );
    }),
  );

  it.effect("resume_subagent retries the task as a new child attempt", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession();
      yield* delegate(sessionId, 'call run_subagent {"task":"collect facts"}');
      const ids = yield* latestAttempt(sessionId);
      yield* sqlTransaction(
        Effect.gen(function* () {
          yield* sqlRun(
            "UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?",
            ids.attempt_id,
          );
          yield* sqlRun(
            "UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?",
            ids.task_id,
          );
        }),
      );
      const resumed = yield* delegate(
        sessionId,
        `call resume_subagent ${yield* encodeJson({ taskId: ids.task_id, expectedAttemptId: ids.attempt_id })}`,
      );
      expect(resumed).toContain('"status":"completed"');
      expect(resumed).toContain("Retry this task as a new execution attempt");
      const result = yield* Schema.decodeUnknownEffect(ResumeResult)(
        yield* sqlGet(
          `SELECT count(*) AS attempts,
                  (SELECT status FROM agent_run_attempts WHERE task_id = ?
                   ORDER BY attempt_number DESC LIMIT 1) AS latest_status
             FROM agent_run_attempts WHERE task_id = ?`,
          ids.task_id,
          ids.task_id,
        ),
      );
      expect(result).toEqual({ attempts: 2, latest_status: "completed" });
    }),
  );
});

// Reopening replaces the block's agent, so each restart test has a block of its own and reads
// services through `env.use` once it has reopened.
testAgent({ testProvider: { responder: heldDefaultTurn } })("subagent blocked recovery", (it) => {
  it.effect("a restart blocks a task whose tool call never settled and never retries it", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId } = yield* parentSession();
      yield* delegate(sessionId, 'call run_subagent {"task":"write externally"}');
      const ids = yield* latestAttempt(sessionId);
      yield* sqlTransaction(
        Effect.gen(function* () {
          yield* sqlRun(
            `UPDATE agent_run_attempts SET status = 'running', finished_at = NULL,
               pending_tool_call_ids = '["non-idempotent-write"]' WHERE id = ?`,
            ids.attempt_id,
          );
          yield* sqlRun(
            "UPDATE work_tasks SET status = 'running', active_attempt_id = ? WHERE id = ?",
            ids.attempt_id,
            ids.task_id,
          );
        }),
      );
      yield* env.reopen;
      expect(
        yield* sqlGet("SELECT failure FROM agent_run_attempts WHERE id = ?", ids.attempt_id),
      ).toEqual({ failure: '{"reason":{"_tag":"ServerRestarted"},"stage":"restart"}' });
      expect(
        yield* sqlGet("SELECT status, active_attempt_id FROM work_tasks WHERE id = ?", ids.task_id),
      ).toEqual({ status: "blocked", active_attempt_id: null });
      yield* send(sessionId, "continue");
      expect(
        yield* sqlGet(
          "SELECT count(*) AS attempts FROM agent_run_attempts WHERE task_id = ?",
          ids.task_id,
        ),
      ).toEqual({ attempts: 1 });
    }),
  );
});

testAgent({ testProvider: { responder: heldDefaultTurn } })(
  "subagent recovery after restart",
  (it) => {
    it.effect(
      "cancelling the parent stops a waiting child, and a restart reruns one only when asked",
      () =>
        Effect.gen(function* () {
          const env = yield* TestEnv;
          const { sessionId } = yield* parentSession("ask");
          const subagents = yield* Subagents;
          const relayed = yield* RelayedApprovals;
          const run = yield* Effect.forkChild(
            send(sessionId, 'call run_subagent {"task":"shell: printf never-runs"}'),
          );
          yield* until(
            Effect.map(relayed.pending(sessionId), (pending) => pending.length === 1),
            "the child's approval",
          );
          yield* (yield* AgentChat).cancel(sessionId, null);
          yield* Fiber.join(run);
          yield* until(
            Effect.map(subagents.list(sessionId), (listed) => listed[0]?.status === "cancelled"),
            "the child to stop",
          );
          expect(yield* relayed.pending(sessionId)).toEqual([]);
          // Finish a child with no unfinished tool call, then simulate a crash while that newest
          // child attempt is still running.
          yield* delegate(sessionId, 'call run_subagent {"task":"recover facts"}');
          const ids = yield* latestAttempt(sessionId);
          yield* sqlTransaction(
            Effect.gen(function* () {
              yield* sqlRun(
                "UPDATE subagents SET status = 'running' WHERE session_id = ?",
                sessionId,
              );
              yield* sqlRun(
                "UPDATE agent_run_attempts SET status = 'running', finished_at = NULL WHERE id = ?",
                ids.attempt_id,
              );
              yield* sqlRun(
                "UPDATE work_tasks SET status = 'running', active_attempt_id = ? WHERE id = ?",
                ids.attempt_id,
                ids.task_id,
              );
            }),
          );
          yield* env.reopen;
          expect((yield* (yield* env.use(Subagents)).list(sessionId))[0]?.status).toBe(
            "interrupted",
          );
          expect(
            yield* Schema.decodeUnknownEffect(RestartedTrace)(
              yield* sqlGet(
                `SELECT a.status AS attempt_status, a.resume_reason, t.status AS task_status,
                  t.active_attempt_id
               FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
               WHERE a.id = ?`,
                ids.attempt_id,
              ),
            ),
          ).toEqual({
            attempt_status: "interrupted",
            task_status: "resumable",
            active_attempt_id: null,
            resume_reason: "server_restarted",
          });
          // The parent hears why the child stopped; nothing reruns it on its own.
          expect(
            yield* sqlGet(
              `SELECT json_extract(payload, '$.failure.reason._tag') AS reason
             FROM parent_notifications WHERE task_id = ? AND kind = 'interrupted'`,
              ids.task_id,
            ),
          ).toEqual({ reason: "ServerRestarted" });
          const attempts = () =>
            sqlGet(
              `SELECT count(*) AS attempts,
                (SELECT status FROM agent_run_attempts WHERE task_id = ?
                 ORDER BY attempt_number DESC LIMIT 1) AS latest_status
             FROM agent_run_attempts WHERE task_id = ?`,
              ids.task_id,
              ids.task_id,
            );
          yield* send(sessionId, "continue");
          expect(yield* attempts()).toEqual({ attempts: 1, latest_status: "interrupted" });
          const retry = yield* (yield* env.use(AgentChat)).requestTraceResume(
            sessionId,
            null,
            ids.task_id,
            ids.attempt_id,
            false,
          );
          expect(retry.status).toBe(202);
          yield* send(sessionId, "continue");
          yield* until(
            Effect.map(
              attempts(),
              (row) =>
                Schema.is(ResumeResult)(row) &&
                row.attempts === 2 &&
                row.latest_status === "completed",
            ),
            "the requested retry to finish",
          );
        }),
    );
  },
);
