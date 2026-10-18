import { Effect, Fiber, FileSystem, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { RelayedApprovals } from "../../src/approvals/relayed.ts";
import { Database } from "../../src/db/database.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import type { PermissionMode } from "../../src/projects/projects.ts";
import { Subagents, subagentThreadId } from "../../src/subagents/subagents.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import {
  current,
  encodeJson,
  freshProject,
  heldDefaultTurn,
  heldTurns,
  sdk,
  send,
  until,
} from "./agent-env.ts";

const TraceSummary = Schema.Struct({
  task_id: Schema.String,
  attempt_id: Schema.String,
  task_status: Schema.String,
  attempt_status: Schema.String,
  parent_run_id: Schema.String,
  parent_tool_call_id: Schema.String,
  chat_run_id: Schema.String,
  event_kinds: Schema.String,
  checkpoints: Schema.Finite,
  evidence_kinds: Schema.String,
  evidence_count: Schema.Finite,
});
const ResumeIds = Schema.Struct({ task_id: Schema.String, attempt_id: Schema.String });
const ResumeResult = Schema.Struct({ attempts: Schema.Finite, latest_status: Schema.String });
const ArtifactSummary = Schema.Struct({ kind: Schema.String, locator: Schema.String });
const LocatorRows = Schema.Array(Schema.Struct({ locator: Schema.String }));
const RestartedTrace = Schema.Struct({
  attempt_status: Schema.String,
  task_status: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  resume_reason: Schema.NullOr(Schema.String),
});
const JobStatus = Schema.Struct({ status: Schema.String });

/** A parent session in a project of its own, with the test model chosen. */
const parentSession = Effect.fnUntraced(function* (mode: PermissionMode = "ask") {
  yield* current(selectTestModel());
  return yield* freshProject(mode);
});

/** The latest child attempt started from the session. */
const latestAttempt = (db: Database["Service"], sessionId: string) =>
  Schema.decodeUnknownEffect(ResumeIds)(
    db.sqlite
      .prepare(
        `SELECT t.id AS task_id, a.id AS attempt_id
         FROM work_tasks t JOIN agent_run_attempts a ON a.task_id = t.id
         WHERE t.origin_session_id = ? ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(sessionId),
  );

testAgent({ testProvider: { responder: heldDefaultTurn } })("subagents", (it) => {
  it.effect(
    "a one-off child gets only the task, the parent's tools minus subagents, and reports back",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* TestEnv;
        const { project, sessionId } = yield* parentSession();
        const subagents = yield* Subagents;
        const db = yield* Database;
        const chat = yield* AgentChat;
        yield* (yield* FileSystem.FileSystem).writeFileString(
          (yield* Path.Path).join(project.root, "AGENTS.md"),
          "ROOT INSTRUCTIONS FOR EVERY AGENT",
        );
        const answer = yield* send(sessionId, 'call run_subagent {"task":"list what matters"}');
        expect(answer).toContain("child done: list what matters (earlier user messages: 0)");
        expect(answer).toContain('"status":"completed"');
        const [child] = yield* subagents.list(sessionId);
        expect(child).toMatchObject({
          name: null,
          status: "completed",
          lastTask: "list what matters",
        });
        const invocations = provider!.adapter.invocations;
        const parentStart = invocations.find((invocation) => invocation.threadId === sessionId);
        const childStart = invocations.find(
          (invocation) => invocation.threadId === subagentThreadId(child!.id),
        );
        expect(parentStart?.systemPrompts.join("\n")).toContain(
          "You can delegate with run_subagent",
        );
        expect(childStart?.systemPrompts.join("\n")).toContain("You are a subagent");
        expect(parentStart?.toolNames).toContain("run_subagent");
        expect(parentStart?.systemPrompts.join("\n")).toContain(
          "ROOT INSTRUCTIONS FOR EVERY AGENT",
        );
        expect(childStart?.systemPrompts.join("\n")).toContain("ROOT INSTRUCTIONS FOR EVERY AGENT");
        // No nesting, and nothing the parent does not have.
        for (const tool of [
          "run_subagent",
          "message_subagent",
          "update_goal",
          "update_plan",
          "update_workflow_progress",
          "record_workflow_blocker",
          "delegate_to_agent",
        ])
          expect(childStart?.toolNames).not.toContain(tool);
        expect(
          childStart?.systemPrompts.some((prompt) => prompt.includes("Current workflow")),
        ).toBe(false);
        expect(childStart?.toolNames).toContain("read_subagent_tool_result");
        // The only child-specific tool reads bounded pages of that child's own persisted results.
        expect(
          childStart?.toolNames
            .filter((name) => name !== "read_subagent_tool_result")
            .every((name) => parentStart?.toolNames.includes(name)),
        ).toBe(true);
        // The parent's conversation is not copied into the child.
        expect(
          childStart?.messages.some(
            (message) =>
              message.role === "user" &&
              Schema.is(Schema.String)(message.content) &&
              message.content.includes("call run_subagent"),
          ),
        ).toBe(false);
        const transcript = yield* sdk(() => subagents.transcript(sessionId, child!.id));
        expect(transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        const trace = yield* Schema.decodeUnknownEffect(TraceSummary)(
          db.sqlite
            .prepare(
              `SELECT t.id AS task_id, a.id AS attempt_id,
                  t.status AS task_status, a.status AS attempt_status,
                  t.parent_run_id, t.parent_tool_call_id, a.chat_run_id,
                  (SELECT group_concat(kind, ',') FROM run_events e
                   WHERE e.attempt_id = a.id ORDER BY e.attempt_sequence) AS event_kinds,
                  (SELECT count(*) FROM work_checkpoints c WHERE c.attempt_id = a.id) AS checkpoints,
                  (SELECT group_concat(source_kind, ',') FROM evidence_refs r
                   WHERE r.attempt_id = a.id ORDER BY r.created_at, r.id) AS evidence_kinds,
                  (SELECT count(*) FROM evidence_refs r WHERE r.attempt_id = a.id) AS evidence_count
               FROM work_tasks t
               JOIN agent_run_attempts a ON a.task_id = t.id
               WHERE t.agent_id = ?`,
            )
            .get(child!.id),
        );
        expect(trace).toMatchObject({ task_status: "completed", attempt_status: "completed" });
        expect(trace.parent_run_id).not.toBe("");
        expect(trace.parent_tool_call_id).not.toBe("");
        expect(trace.chat_run_id).not.toBe("");
        expect(trace.event_kinds.split(",")).toEqual([
          "attempt_queued",
          "attempt_started",
          "checkpoint_created",
          "attempt_completed",
          "report_returned",
          "report_reviewed",
          "report_not_used",
        ]);
        expect(trace.checkpoints).toBe(1);
        expect(trace.evidence_count).toBe(2);
        expect(trace.evidence_kinds.split(",").sort()).toEqual(["checkpoint", "message"]);
        expect(
          yield* encodeJson(
            db.sqlite
              .prepare("SELECT locator FROM evidence_refs WHERE attempt_id = ?")
              .all(trace.attempt_id),
          ),
        ).not.toContain("child done: list what matters");

        const tree = yield* chat.traceTree(sessionId);
        expect(tree.status).toBe(200);
        expect(yield* sdk(() => tree.text())).toContain(trace.task_id);
        const detailResponse = yield* chat.traceTask(sessionId, trace.task_id);
        expect(detailResponse.status).toBe(200);
        const detail = yield* sdk(() => detailResponse.text());
        expect(detail).toContain(trace.chat_run_id);
        expect(detail).toContain('"sourceKind":"message"');
        expect(detail).toContain('"sourceKind":"checkpoint"');
        const terminalResume = yield* chat.requestTraceResume(
          sessionId,
          null,
          trace.task_id,
          trace.attempt_id,
          false,
        );
        expect(terminalResume.status).toBe(409);
        expect(yield* sdk(() => terminalResume.json())).toEqual({
          status: "blocked",
          reason: "task_terminal",
        });
        db.atomic(() => {
          db.sqlite
            .prepare("UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?")
            .run(trace.attempt_id);
          db.sqlite
            .prepare(
              "UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?",
            )
            .run(trace.task_id);
        });
        const queuedResume = yield* chat.requestTraceResume(
          sessionId,
          null,
          trace.task_id,
          trace.attempt_id,
          false,
        );
        expect(queuedResume.status).toBe(202);
        expect(yield* sdk(() => queuedResume.json())).toMatchObject({
          status: "queued",
          taskId: trace.task_id,
          expectedAttemptId: trace.attempt_id,
        });
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
      expect(answer.indexOf("napped: nap A")).toBeGreaterThan(-1);
      expect(answer.indexOf("napped: nap A")).toBeLessThan(answer.indexOf("napped: nap B"));
      expect((yield* (yield* Subagents).list(sessionId)).map((child) => child.status)).toEqual([
        "completed",
        "completed",
      ]);
    }),
  );

  it.effect("a named child keeps its own conversation across the session's runs", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession();
      yield* send(sessionId, 'call message_subagent {"agent":"helper","message":"first task"}');
      const second = yield* send(
        sessionId,
        'call message_subagent {"agent":"helper","message":"second task"}',
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
      const db = yield* Database;
      const approved = yield* Effect.forkChild(
        send(sessionId, 'call run_subagent {"task":"shell: printf child-approved"}'),
      );
      yield* until(
        Effect.map(relayed.pending(sessionId), (pending) => pending.length === 1),
        "the child's approval",
      );
      const [request] = yield* relayed.pending(sessionId);
      expect(request).toMatchObject({
        toolName: "save_shell_skill",
        askedBy: "every_call",
        requester: { kind: "subagent", name: null },
      });
      expect(yield* relayed.answer("another-session", request!.id, true)).toBe(false);
      expect(yield* relayed.answer(sessionId, request!.id, true)).toBe(true);
      const approvedAnswer = yield* Fiber.join(approved);
      expect(approvedAnswer).toContain("scriptSha256");
      const denied = yield* Effect.forkChild(
        send(sessionId, 'call run_subagent {"task":"shell: printf child-denied"}'),
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
      const toolEvidenceCount = (agentId: string) =>
        db.sqlite
          .prepare(
            `SELECT count(*) AS count FROM evidence_refs e
             JOIN work_tasks t ON t.id = e.task_id
             WHERE t.agent_id = ? AND e.source_kind IN ('tool_call', 'tool_result')`,
          )
          .get(agentId);
      expect(toolEvidenceCount(children[0]!.id)).toEqual({ count: 2 });
      expect(toolEvidenceCount(children[1]!.id)).toEqual({ count: 2 });
      expect(
        db.sqlite
          .prepare(
            `SELECT verification FROM evidence_refs e
             JOIN work_tasks t ON t.id = e.task_id
             WHERE t.agent_id = ? AND e.source_kind = 'tool_result'`,
          )
          .get(children[1]!.id),
      ).toEqual({ verification: "verified" });
      // Tool evidence points at calls that the child's transcript really holds.
      for (const child of children) {
        const transcript = yield* sdk(() => subagents.transcript(sessionId, child.id));
        const persisted = yield* encodeJson(transcript?.messages ?? []);
        const locators = yield* Schema.decodeUnknownEffect(LocatorRows)(
          db.sqlite
            .prepare(
              `SELECT e.locator FROM evidence_refs e
               JOIN work_tasks t ON t.id = e.task_id
               WHERE t.agent_id = ? AND e.source_kind IN ('tool_call', 'tool_result')`,
            )
            .all(child.id),
        );
        for (const { locator } of locators) {
          const { toolCallId } = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ toolCallId: Schema.String })),
          )(locator);
          expect(persisted).toContain(toolCallId);
        }
      }
    }),
  );

  it.effect("a child file write records the actual artifact without copying its contents", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession("full");
      const db = yield* Database;
      const answer = yield* send(
        sessionId,
        'call run_subagent {"task":"call write_file {\\"path\\":\\"wt-artifact.txt\\",\\"content\\":\\"artifact sentinel body\\"}"}',
      );
      expect(answer).toContain("write_file said");
      const artifact = yield* Schema.decodeUnknownEffect(ArtifactSummary)(
        db.sqlite
          .prepare(
            `SELECT w.kind, w.locator FROM work_artifacts w
             JOIN work_tasks t ON t.id = w.task_id
             WHERE t.agent_id = ?`,
          )
          .get((yield* (yield* Subagents).list(sessionId))[0]!.id),
      );
      expect(artifact.kind).toBe("file");
      expect(artifact.locator).toContain('"path":"wt-artifact.txt"');
      expect(
        yield* encodeJson({
          evidence: db.sqlite.prepare("SELECT * FROM evidence_refs").all(),
          artifacts: db.sqlite.prepare("SELECT * FROM work_artifacts").all(),
        }),
      ).not.toContain("artifact sentinel body");
    }),
  );

  it.effect("resume_subagent runs a new child attempt from the durable checkpoint", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* parentSession();
      const db = yield* Database;
      yield* send(sessionId, 'call run_subagent {"task":"collect facts"}');
      const ids = yield* latestAttempt(db, sessionId);
      db.atomic(() => {
        db.sqlite
          .prepare("UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?")
          .run(ids.attempt_id);
        db.sqlite
          .prepare(
            "UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?",
          )
          .run(ids.task_id);
      });
      const resumed = yield* send(
        sessionId,
        `call resume_subagent ${yield* encodeJson({ taskId: ids.task_id, expectedAttemptId: ids.attempt_id })}`,
      );
      expect(resumed).toContain('"status":"completed"');
      expect(resumed).toContain("Resume the interrupted task as a new execution attempt");
      const result = yield* Schema.decodeUnknownEffect(ResumeResult)(
        db.sqlite
          .prepare(
            `SELECT count(*) AS attempts,
                  (SELECT status FROM agent_run_attempts WHERE task_id = ?
                   ORDER BY attempt_number DESC LIMIT 1) AS latest_status
             FROM agent_run_attempts WHERE task_id = ?`,
          )
          .get(ids.task_id, ids.task_id),
      );
      expect(result).toEqual({ attempts: 2, latest_status: "completed" });
    }),
  );
});

// Reopening replaces the block's agent, so each restart test has a block of its own and reads
// services through `env.use` once it has reopened.
testAgent({ testProvider: { responder: heldDefaultTurn } })("subagent blocked recovery", (it) => {
  it.effect("restart recovery stays blocked when the checkpoint has an uncertain side effect", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId } = yield* parentSession();
      yield* send(sessionId, 'call run_subagent {"task":"write externally"}');
      const db = yield* Database;
      const ids = yield* latestAttempt(db, sessionId);
      db.atomic(() => {
        db.sqlite
          .prepare(
            `UPDATE work_checkpoints SET uncertain_tool_call_ids = '["non-idempotent-write"]'
             WHERE attempt_id = ?`,
          )
          .run(ids.attempt_id);
        db.sqlite
          .prepare(
            "UPDATE agent_run_attempts SET status = 'running', finished_at = NULL WHERE id = ?",
          )
          .run(ids.attempt_id);
        db.sqlite
          .prepare("UPDATE work_tasks SET status = 'running', active_attempt_id = ? WHERE id = ?")
          .run(ids.attempt_id, ids.task_id);
      });
      yield* env.reopen;
      const reopened = yield* env.use(Database);
      const recoveryJob = () =>
        reopened.sqlite
          .prepare("SELECT status, blocker FROM work_recovery_jobs WHERE task_id = ?")
          .get(ids.task_id);
      expect(recoveryJob()).toEqual({ status: "blocked", blocker: "uncertain_side_effect" });
      expect(
        reopened.sqlite
          .prepare("SELECT status, active_attempt_id FROM work_tasks WHERE id = ?")
          .get(ids.task_id),
      ).toEqual({ status: "blocked", active_attempt_id: null });
      yield* send(sessionId, "continue");
      expect(
        reopened.sqlite
          .prepare("SELECT count(*) AS attempts FROM agent_run_attempts WHERE task_id = ?")
          .get(ids.task_id),
      ).toEqual({ attempts: 1 });
      expect(recoveryJob()).toEqual({ status: "blocked", blocker: "uncertain_side_effect" });
    }),
  );
});

testAgent({ testProvider: { responder: heldDefaultTurn } })(
  "subagent recovery after restart",
  (it) => {
    it.effect("cancelling the parent stops a waiting child, and a restart never reruns one", () =>
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
        expect((yield* (yield* AgentChat).cancel(sessionId, null)).status).toBe(200);
        yield* Fiber.join(run);
        yield* until(
          Effect.map(subagents.list(sessionId), (listed) => listed[0]?.status === "cancelled"),
          "the child to stop",
        );
        expect(yield* relayed.pending(sessionId)).toEqual([]);
        // Create a safe checkpoint with no uncertain tool side effects, then simulate a crash while
        // that newest child attempt is still running.
        yield* send(sessionId, 'call run_subagent {"task":"recover facts"}');
        const db = yield* Database;
        const ids = yield* latestAttempt(db, sessionId);
        db.atomic(() => {
          db.sqlite
            .prepare("UPDATE subagents SET status = 'running' WHERE session_id = ?")
            .run(sessionId);
          db.sqlite
            .prepare(
              "UPDATE agent_run_attempts SET status = 'running', finished_at = NULL WHERE id = ?",
            )
            .run(ids.attempt_id);
          db.sqlite
            .prepare("UPDATE work_tasks SET status = 'running', active_attempt_id = ? WHERE id = ?")
            .run(ids.attempt_id, ids.task_id);
        });
        yield* env.reopen;
        expect((yield* (yield* env.use(Subagents)).list(sessionId))[0]?.status).toBe("interrupted");
        const reopened = yield* env.use(Database);
        expect(
          yield* Schema.decodeUnknownEffect(RestartedTrace)(
            reopened.sqlite
              .prepare(
                `SELECT a.status AS attempt_status, a.resume_reason, t.status AS task_status,
                  t.active_attempt_id
               FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
               WHERE a.id = ?`,
              )
              .get(ids.attempt_id),
          ),
        ).toEqual({
          attempt_status: "interrupted",
          task_status: "resumable",
          active_attempt_id: null,
          resume_reason: "server_restarted",
        });
        const recoveryJob = () =>
          reopened.sqlite
            .prepare("SELECT status, blocker FROM work_recovery_jobs WHERE task_id = ?")
            .get(ids.task_id);
        expect(recoveryJob()).toEqual({ status: "queued", blocker: null });
        yield* send(sessionId, "continue");
        yield* until(() => {
          const job = recoveryJob();
          return (
            Schema.is(JobStatus)(job) && ["completed", "failed", "blocked"].includes(job.status)
          );
        }, "the recovery job to finish");
        expect(recoveryJob()).toMatchObject({ status: "completed" });
        expect(
          reopened.sqlite
            .prepare("SELECT count(*) AS attempts FROM agent_run_attempts WHERE task_id = ?")
            .get(ids.task_id),
        ).toEqual({ attempts: 2 });
        const trace = yield* env.use(WorkTraceStore);
        const notifications = yield* trace.consumeParentNotifications(
          sessionId,
          `${sessionId}:next`,
        );
        // Resumed may already have reached the active parent's next model boundary. Completion
        // remains durable until either the active turn, idle follow-up, or this explicit consumer.
        expect(
          notifications.every((notification) =>
            ["resumed", "completed"].includes(notification.kind),
          ),
        ).toBe(true);
        expect(
          reopened.sqlite
            .prepare(
              `SELECT count(*) AS count FROM parent_notifications
             WHERE origin_session_id = ? AND kind IN ('resumed', 'completed')
               AND delivered_at IS NOT NULL`,
            )
            .get(sessionId),
        ).toEqual({ count: 3 });
        expect(yield* trace.consumeParentNotifications(sessionId, `${sessionId}:another`)).toEqual(
          [],
        );
      }),
    );
  },
);
