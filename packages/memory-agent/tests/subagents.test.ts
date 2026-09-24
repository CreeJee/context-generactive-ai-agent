import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Projects } from "../src/projects/projects.ts";
import { RelayedApprovals } from "../src/approvals/relayed.ts";
import { compactChildToolResults, Subagents } from "../src/subagents/subagents.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const Delta = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);
const JobStatus = Schema.Struct({ status: Schema.String });

const RestartedTrace = Schema.Struct({
  attempt_status: Schema.String,
  task_status: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  resume_reason: Schema.NullOr(Schema.String),
});

const ResumeIds = Schema.Struct({ task_id: Schema.String, attempt_id: Schema.String });
const ResumeResult = Schema.Struct({ attempts: Schema.Finite, latest_status: Schema.String });
const ArtifactSummary = Schema.Struct({ kind: Schema.String, locator: Schema.String });
const LocatorRows = Schema.Array(Schema.Struct({ locator: Schema.String }));

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

const answerOf = (events: string) =>
  events
    .split("\n")
    .flatMap((line) => (line.startsWith("data: ") ? [Schema.decodeSync(Delta)(line.slice(6))] : []))
    .flatMap((event) => (event.type === "TEXT_MESSAGE_CONTENT" && event.delta ? [event.delta] : []))
    .join("");

async function subagentSetup(mode: "ask" | "auto" | "full" = "ask") {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  await context.runtime.runPromise(
    Effect.flatMap(Projects, (projects) => projects.setPermissionMode(context.project.id, mode)),
  );
  const subagents = await context.runtime.runPromise(Subagents);
  const relayed = await context.runtime.runPromise(RelayedApprovals);
  const state = () => ({
    subagents: subagents.list(context.session.id),
    approvals: relayed.pending(context.session.id),
  });
  /** Starts a run; its events are read in the background until it ends. */
  const send = async (text: string) => {
    const response = await context.runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: context.session.id,
              runId: `run-${Math.random().toString(36).slice(2)}`,
              messages: [{ id: "m1", role: "user", content: text }],
              tools: [],
              context: [],
            }),
          }),
          context.session.id,
        ),
      ),
    );
    return response.text().then(answerOf);
  };
  return { ...context, subagents, relayed, state, send };
}

describe("subagents", () => {
  test("older saved child results are references only in the provider copy", () => {
    const content = "output".repeat(1_000);
    const messages = [
      { role: "tool" as const, toolCallId: "old", content },
      { role: "assistant" as const, content: "finished" },
      { role: "tool" as const, toolCallId: "current", content },
    ];
    const sent = compactChildToolResults(messages, new Set(["old", "current"]));
    expect(sent[0]?.content).toContain("read_subagent_tool_result");
    expect(JSON.stringify(sent[0]?.content).length).toBeLessThan(content.length / 10);
    expect(sent[2]?.content).toBe(content);
    expect(messages[0]?.content).toBe(content);
    expect(compactChildToolResults(messages, new Set())[0]?.content).toBe(content);
  });

  test("a one-off child gets only the task, the parent's tools minus subagents, and reports back", async () => {
    const { send, subagents, session, state, provider, runtime } = await subagentSetup();

    const answer = await send('call run_subagent {"task":"list what matters"}');
    expect(answer).toContain("child done: list what matters (earlier user messages: 0)");
    expect(answer).toContain('"status":"completed"');

    const [child] = state().subagents;
    expect(child).toMatchObject({ name: null, status: "completed", lastTask: "list what matters" });

    const invocations = provider!.adapter.invocations;
    const childStart = invocations.find((invocation) =>
      invocation.systemPrompts.some((prompt) => prompt.includes("You are a subagent")),
    );
    const parentStart = invocations.find((invocation) =>
      invocation.systemPrompts.some((prompt) =>
        prompt.includes("You can delegate with run_subagent"),
      ),
    );
    expect(parentStart?.toolNames).toContain("run_subagent");
    // No nesting, and nothing the parent does not have.
    expect(childStart?.toolNames).not.toContain("run_subagent");
    expect(childStart?.toolNames).not.toContain("message_subagent");
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

    const transcript = await subagents.transcript(session.id, child!.id);
    expect(transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const db = await runtime.runPromise(Database);
    const trace = Schema.decodeUnknownSync(TraceSummary)(
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
    expect(trace).toMatchObject({
      task_status: "completed",
      attempt_status: "completed",
    });
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
      JSON.stringify(
        db.sqlite
          .prepare("SELECT locator FROM evidence_refs WHERE attempt_id = ?")
          .all(trace.attempt_id),
      ),
    ).not.toContain("child done: list what matters");

    const chatApi = await runtime.runPromise(AgentChat);
    const treeResponse = await runtime.runPromise(chatApi.traceTree(session.id));
    expect(treeResponse.status).toBe(200);
    expect(await treeResponse.text()).toContain(trace.task_id);
    const detailResponse = await runtime.runPromise(chatApi.traceTask(session.id, trace.task_id));
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.text();
    expect(detail).toContain(trace.chat_run_id);
    expect(detail).toContain('"sourceKind":"message"');
    expect(detail).toContain('"sourceKind":"checkpoint"');
    const terminalResume = await runtime.runPromise(
      chatApi.requestTraceResume(session.id, null, trace.task_id, trace.attempt_id, false),
    );
    expect(terminalResume.status).toBe(409);
    expect(await terminalResume.json()).toEqual({ status: "blocked", reason: "task_terminal" });
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
    const queuedResume = await runtime.runPromise(
      chatApi.requestTraceResume(session.id, null, trace.task_id, trace.attempt_id, false),
    );
    expect(queuedResume.status).toBe(202);
    expect(await queuedResume.json()).toMatchObject({
      status: "queued",
      taskId: trace.task_id,
      expectedAttemptId: trace.attempt_id,
    });
    const streamResponse = await runtime.runPromise(
      chatApi.traceStream(new Request("http://local/trace/stream?after=0"), session.id),
    );
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamResponse.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
    await reader.cancel();
    const invalidCursor = await runtime.runPromise(
      chatApi.traceStream(new Request("http://local/trace/stream?after=nope"), session.id),
    );
    expect(invalidCursor.status).toBe(400);
  });

  test("subagent calls of one step run at the same time and answer in call order", async () => {
    const { send, state } = await subagentSetup();

    const started = Date.now();
    const answer = await send("delegate twice");
    const elapsed = Date.now() - started;
    expect(answer.indexOf("napped: nap A")).toBeGreaterThan(-1);
    expect(answer.indexOf("napped: nap A")).toBeLessThan(answer.indexOf("napped: nap B"));
    // Each child naps 700ms; one after another would take at least 1400ms.
    expect(elapsed).toBeLessThan(1350);
    expect(state().subagents.map((child) => child.status)).toEqual(["completed", "completed"]);
  });

  test("a named child keeps its own conversation across the session's runs", async () => {
    const { send, state } = await subagentSetup();

    await send('call message_subagent {"agent":"helper","message":"first task"}');
    const second = await send('call message_subagent {"agent":"helper","message":"second task"}');
    expect(second).toContain("child done: second task (earlier user messages: 1)");
    const children = state().subagents;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ name: "helper", lastTask: "second task" });
  });

  test("a child's gated call waits for the user on the page, and a denial never runs it", async () => {
    const { send, subagents, relayed, session, state, runtime } = await subagentSetup("ask");

    const approved = send('call run_subagent {"task":"shell: printf child-approved"}');
    await until(() => state().approvals.length === 1, "the child's approval");
    const [request] = state().approvals;
    expect(request).toMatchObject({
      toolName: "run_shell",
      askedBy: "every_call",
      requester: { kind: "subagent", name: null },
    });
    expect(relayed.answer("another-session", request!.id, true)).toBe(false);
    expect(relayed.answer(session.id, request!.id, true)).toBe(true);
    const approvedAnswer = await approved;
    expect(approvedAnswer).toContain("child-approved");
    expect(approvedAnswer).toContain("exitCode");

    const denied = send('call run_subagent {"task":"shell: printf child-denied"}');
    await until(() => state().approvals.length === 1, "the second approval");
    relayed.answer(session.id, state().approvals[0]!.id, false);
    const deniedAnswer = await denied;
    expect(deniedAnswer).toContain("User denied this action");
    expect(deniedAnswer).not.toContain("exitCode");

    const reviews = await runtime.runPromise(PermissionReviews);
    const children = state().subagents;
    expect(reviews.latest(session.id, `subagent-${children[0]!.id}:call-shell`)?.decision).toBe(
      "approved",
    );
    expect(reviews.latest(session.id, `subagent-${children[1]!.id}:call-shell`)?.decision).toBe(
      "denied",
    );
    const db = await runtime.runPromise(Database);
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
    for (const child of children) {
      const transcript = await subagents.transcript(session.id, child.id);
      const persisted = JSON.stringify(transcript?.messages ?? []);
      const locators = Schema.decodeUnknownSync(LocatorRows)(
        db.sqlite
          .prepare(
            `SELECT e.locator FROM evidence_refs e
             JOIN work_tasks t ON t.id = e.task_id
             WHERE t.agent_id = ? AND e.source_kind IN ('tool_call', 'tool_result')`,
          )
          .all(child.id),
      );
      for (const { locator } of locators) {
        const toolCallId = Schema.decodeSync(
          Schema.fromJsonString(Schema.Struct({ toolCallId: Schema.String })),
        )(locator).toolCallId;
        expect(persisted).toContain(toolCallId);
      }
    }
  });

  test("a child file write records the actual artifact without copying its contents", async () => {
    const { send, state, runtime } = await subagentSetup("full");
    const answer = await send(
      'call run_subagent {"task":"call write_file {\\"path\\":\\"wt-artifact.txt\\",\\"content\\":\\"artifact sentinel body\\"}"}',
    );
    expect(answer).toContain("write_file said");

    const db = await runtime.runPromise(Database);
    const artifact = Schema.decodeUnknownSync(ArtifactSummary)(
      db.sqlite
        .prepare(
          `SELECT w.kind, w.locator FROM work_artifacts w
           JOIN work_tasks t ON t.id = w.task_id
           WHERE t.agent_id = ?`,
        )
        .get(state().subagents[0]!.id),
    );
    expect(artifact.kind).toBe("file");
    expect(artifact.locator).toContain('"path":"wt-artifact.txt"');
    expect(
      JSON.stringify({
        evidence: db.sqlite.prepare("SELECT * FROM evidence_refs").all(),
        artifacts: db.sqlite.prepare("SELECT * FROM work_artifacts").all(),
      }),
    ).not.toContain("artifact sentinel body");
  });

  test("resume_subagent runs a new child attempt from the durable checkpoint", async () => {
    const { send, session, runtime } = await subagentSetup();
    await send('call run_subagent {"task":"collect facts"}');
    const db = await runtime.runPromise(Database);
    const ids = Schema.decodeUnknownSync(ResumeIds)(
      db.sqlite
        .prepare(
          `SELECT t.id AS task_id, a.id AS attempt_id
           FROM work_tasks t JOIN agent_run_attempts a ON a.task_id = t.id
           WHERE t.origin_session_id = ? ORDER BY a.created_at DESC LIMIT 1`,
        )
        .get(session.id),
    );
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

    const resumed = await send(
      `call resume_subagent ${JSON.stringify({ taskId: ids.task_id, expectedAttemptId: ids.attempt_id })}`,
    );
    expect(resumed).toContain('"status":"completed"');
    expect(resumed).toContain("Resume the interrupted task as a new execution attempt");
    const result = Schema.decodeUnknownSync(ResumeResult)(
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
  });

  test("restart recovery stays blocked when the checkpoint has an uncertain side effect", async () => {
    const { send, session, runtime, reopen } = await subagentSetup();
    await send('call run_subagent {"task":"write externally"}');
    const db = await runtime.runPromise(Database);
    const ids = Schema.decodeUnknownSync(ResumeIds)(
      db.sqlite
        .prepare(
          `SELECT t.id AS task_id, a.id AS attempt_id
           FROM work_tasks t JOIN agent_run_attempts a ON a.task_id = t.id
           WHERE t.origin_session_id = ? ORDER BY a.created_at DESC LIMIT 1`,
        )
        .get(session.id),
    );
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

    const reopened = await reopen();
    const reopenedDb = await reopened.runPromise(Database);
    expect(
      reopenedDb.sqlite
        .prepare("SELECT status, blocker FROM work_recovery_jobs WHERE task_id = ?")
        .get(ids.task_id),
    ).toEqual({ status: "blocked", blocker: "uncertain_side_effect" });
    expect(
      reopenedDb.sqlite
        .prepare("SELECT status, active_attempt_id FROM work_tasks WHERE id = ?")
        .get(ids.task_id),
    ).toEqual({ status: "blocked", active_attempt_id: null });

    const reopenedAgent = await reopened.runPromise(AgentChat);
    const response = await reopened.runPromise(
      reopenedAgent.handle(
        new Request("http://127.0.0.1/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: session.id,
            runId: "blocked-recovery-parent",
            messages: [{ id: "blocked-turn", role: "user", content: "continue" }],
            tools: [],
            context: [],
          }),
        }),
        session.id,
      ),
    );
    await response.text();
    expect(
      reopenedDb.sqlite
        .prepare("SELECT count(*) AS attempts FROM agent_run_attempts WHERE task_id = ?")
        .get(ids.task_id),
    ).toEqual({ attempts: 1 });
    expect(
      reopenedDb.sqlite
        .prepare("SELECT status, blocker FROM work_recovery_jobs WHERE task_id = ?")
        .get(ids.task_id),
    ).toEqual({ status: "blocked", blocker: "uncertain_side_effect" });
  });

  test("cancelling the parent stops a waiting child, and a restart never reruns one", async () => {
    const { send, session, state, runtime, reopen } = await subagentSetup("ask");

    const run = send('call run_subagent {"task":"shell: printf never-runs"}');
    await until(() => state().approvals.length === 1, "the child's approval");
    const cancel = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
    );
    expect(cancel.status).toBe(200);
    await run;
    await until(() => state().subagents[0]?.status === "cancelled", "the child to stop");
    expect(state().approvals).toEqual([]);

    // Create a safe checkpoint with no uncertain tool side effects, then simulate a crash while that
    // newest child attempt is still running.
    await send('call run_subagent {"task":"recover facts"}');
    const db = await runtime.runPromise(Database);
    db.sqlite.prepare("UPDATE subagents SET status = 'running'").run();
    db.atomic(() => {
      db.sqlite
        .prepare(
          `UPDATE agent_run_attempts SET status = 'running', finished_at = NULL
           WHERE id = (SELECT id FROM agent_run_attempts ORDER BY created_at DESC LIMIT 1)`,
        )
        .run();
      db.sqlite
        .prepare(
          `UPDATE work_tasks SET status = 'running', active_attempt_id =
             (SELECT id FROM agent_run_attempts ORDER BY created_at DESC LIMIT 1)
           WHERE id = (SELECT task_id FROM agent_run_attempts ORDER BY created_at DESC LIMIT 1)`,
        )
        .run();
    });
    const reopened = await reopen();
    const after = await reopened.runPromise(Effect.map(Subagents, (s) => s.list(session.id)));
    expect(after[0]?.status).toBe("interrupted");
    const reopenedDb = await reopened.runPromise(Database);
    const restartedTrace = Schema.decodeUnknownSync(RestartedTrace)(
      reopenedDb.sqlite
        .prepare(
          `SELECT a.status AS attempt_status, a.resume_reason, t.status AS task_status,
                  t.active_attempt_id
           FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
           ORDER BY a.created_at DESC LIMIT 1`,
        )
        .get(),
    );
    expect(restartedTrace).toEqual({
      attempt_status: "interrupted",
      task_status: "resumable",
      active_attempt_id: null,
      resume_reason: "server_restarted",
    });
    expect(
      reopenedDb.sqlite
        .prepare("SELECT status, blocker FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1")
        .get(),
    ).toEqual({ status: "queued", blocker: null });
    const reopenedAgent = await reopened.runPromise(AgentChat);
    const recoveryParentRun = "recovery-parent-run";
    const recoveryResponse = await reopened.runPromise(
      reopenedAgent.handle(
        new Request("http://127.0.0.1/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: session.id,
            runId: recoveryParentRun,
            messages: [{ id: "recovery-turn", role: "user", content: "continue" }],
            tools: [],
            context: [],
          }),
        }),
        session.id,
      ),
    );
    await recoveryResponse.text();
    await until(
      () =>
        ["completed", "failed", "blocked"].includes(
          Schema.decodeUnknownSync(JobStatus)(
            reopenedDb.sqlite
              .prepare("SELECT status FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1")
              .get(),
          ).status,
        ),
      "the recovery job to finish",
    );
    expect(
      Schema.decodeUnknownSync(JobStatus)(
        reopenedDb.sqlite
          .prepare("SELECT status FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1")
          .get(),
      ).status,
    ).toBe("completed");
    expect(
      reopenedDb.sqlite
        .prepare(
          `SELECT count(*) AS attempts FROM agent_run_attempts
           WHERE task_id = (SELECT task_id FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1)`,
        )
        .get(),
    ).toEqual({ attempts: 2 });
    const reopenedTrace = await reopened.runPromise(WorkTraceStore);
    const notifications = reopenedTrace.consumeParentNotifications(session.id, "next-parent-run");
    // Resumed may already have reached the active parent's next model boundary. Completion
    // remains durable until either the active turn, idle follow-up, or this explicit consumer.
    expect(
      notifications.every((notification) => ["resumed", "completed"].includes(notification.kind)),
    ).toBe(true);
    expect(
      reopenedDb.sqlite
        .prepare(
          "SELECT count(*) AS count FROM parent_notifications WHERE kind IN ('resumed', 'completed') AND delivered_at IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 3 });
    expect(reopenedTrace.consumeParentNotifications(session.id, "another-run")).toEqual([]);
  });
});
