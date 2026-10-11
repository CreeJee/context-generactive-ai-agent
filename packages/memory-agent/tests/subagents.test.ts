import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { HashSet } from "effect";
import { isTruthy } from "../src/truthy.ts";
import { Cause, Effect, Fiber, FileSystem, Option, Path, Random, Schedule, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Projects } from "../src/projects/projects.ts";
import { RelayedApprovals } from "../src/approvals/relayed.ts";
import { compactChildToolResults, Subagents } from "../src/subagents/subagents.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import {
  selectTestModel,
  defaultTestResponder,
  turnGate,
  type TestProviderOptions,
} from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

const sdkCall = Effect.fn("subagentTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const until = Effect.fn("subagentTest.until")(function* <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  what: string,
) {
  const completed = yield* predicate.pipe(
    Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("20 millis") }),
    Effect.timeoutOption("6000 millis"),
  );
  expect(Option.isSome(completed), what).toBe(true);
});

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

const answerOf = Effect.fn("subagentTest.answerOf")(function* (events: string) {
  const decoded = yield* Effect.forEach(
    events.split("\n").filter((line) => line.startsWith("data: ")),
    (line) => Schema.decodeEffect(Delta)(line.slice(6)),
  );
  return decoded
    .flatMap((event) =>
      event.type === "TEXT_MESSAGE_CONTENT" && isTruthy(event.delta) ? [event.delta] : [],
    )
    .join("");
});

const subagentSetup = Effect.fn("subagentTest.setup")(function* (
  mode: "ask" | "auto" | "full" = "ask",
  testProvider: TestProviderOptions = {},
) {
  const context = yield* sdkCall(() => testRuntime({ testProvider }));
  yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
  yield* Effect.provideContext(
    Effect.flatMap(Projects, (projects) => projects.setPermissionMode(context.project.id, mode)),
    yield* context.runtime.contextEffect,
  );
  const subagents = yield* Effect.provideContext(Subagents, yield* context.runtime.contextEffect);
  const relayed = yield* Effect.provideContext(
    RelayedApprovals,
    yield* context.runtime.contextEffect,
  );
  const state = () => ({
    subagents: subagents.list(context.session.id),
    approvals: relayed.pending(context.session.id),
  });
  /** Starts a run; its events are read in the background until it ends. */
  const send = Effect.fn("subagentTest.send")(function* (text: string) {
    const response = yield* Effect.provideContext(
      Effect.flatMap(
        AgentChat,
        Effect.fnUntraced(function* (agent) {
          return yield* agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: context.session.id,
                runId: `run-${(yield* Random.next).toString(36).slice(2)}`,
                messages: [{ id: "m1", role: "user", content: text }],
                tools: [],
                context: [],
              }),
            }),
            context.session.id,
          );
        }),
      ),
      yield* context.runtime.contextEffect,
    );
    return yield* answerOf(yield* sdkCall(() => response.text()));
  });
  return { ...context, subagents, relayed, state, send };
});

describe("subagents", () => {
  test("older saved child results are references only in the provider copy", () => {
    const content = "output".repeat(1_000);
    const messages = [
      { role: "tool" as const, toolCallId: "old", content },
      { role: "assistant" as const, content: "finished" },
      { role: "tool" as const, toolCallId: "current", content },
    ];
    const sent = compactChildToolResults(messages, HashSet.fromIterable(["old", "current"]));
    expect(sent[0]?.content).toContain("read_subagent_tool_result");
    expect(JSON.stringify(sent[0]?.content).length).toBeLessThan(content.length / 10);
    expect(sent[2]?.content).toContain("Child tool result preview");
    expect(sent[2]?.content).toContain("read_subagent_tool_result");
    expect(JSON.stringify(sent[2]?.content).length).toBeLessThan(content.length);
    expect(messages[2]?.content).toBe(content);
    expect(messages[0]?.content).toBe(content);
    expect(compactChildToolResults(messages, HashSet.empty<string>())[0]?.content).toBe(content);
  });

  it.live(
    "a one-off child gets only the task, the parent's tools minus subagents, and reports back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { send, subagents, session, state, provider, runtime, project } =
          yield* subagentSetup();
        yield* fs.writeFileString(
          path.join(project.root, "AGENTS.md"),
          "ROOT INSTRUCTIONS FOR EVERY AGENT",
        );
        const answer = yield* send('call run_subagent {"task":"list what matters"}');
        expect(answer).toContain("child done: list what matters (earlier user messages: 0)");
        expect(answer).toContain('"status":"completed"');
        const [child] = state().subagents;
        expect(child).toMatchObject({
          name: null,
          status: "completed",
          lastTask: "list what matters",
        });
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
        expect(parentStart?.systemPrompts.join("\n")).toContain(
          "ROOT INSTRUCTIONS FOR EVERY AGENT",
        );
        expect(childStart?.systemPrompts.join("\n")).toContain("ROOT INSTRUCTIONS FOR EVERY AGENT");
        // No nesting, and nothing the parent does not have.
        expect(childStart?.toolNames).not.toContain("run_subagent");
        expect(childStart?.toolNames).not.toContain("message_subagent");
        expect(childStart?.toolNames).not.toContain("update_goal");
        expect(childStart?.toolNames).not.toContain("update_plan");
        expect(childStart?.toolNames).not.toContain("update_workflow_progress");
        expect(childStart?.toolNames).not.toContain("record_workflow_blocker");
        expect(childStart?.toolNames).not.toContain("delegate_to_agent");
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
        const transcript = yield* sdkCall(() => subagents.transcript(session.id, child!.id));
        expect(transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
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
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            db.sqlite
              .prepare("SELECT locator FROM evidence_refs WHERE attempt_id = ?")
              .all(trace.attempt_id),
          ),
        ).not.toContain("child done: list what matters");
        const chatApi = yield* Effect.provideContext(AgentChat, yield* runtime.contextEffect);
        const treeResponse = yield* Effect.provideContext(
          chatApi.traceTree(session.id),
          yield* runtime.contextEffect,
        );
        expect(treeResponse.status).toBe(200);
        expect(yield* sdkCall(() => treeResponse.text())).toContain(trace.task_id);
        const detailResponse = yield* Effect.provideContext(
          chatApi.traceTask(session.id, trace.task_id),
          yield* runtime.contextEffect,
        );
        expect(detailResponse.status).toBe(200);
        const detail = yield* sdkCall(() => detailResponse.text());
        expect(detail).toContain(trace.chat_run_id);
        expect(detail).toContain('"sourceKind":"message"');
        expect(detail).toContain('"sourceKind":"checkpoint"');
        const terminalResume = yield* Effect.provideContext(
          chatApi.requestTraceResume(session.id, null, trace.task_id, trace.attempt_id, false),
          yield* runtime.contextEffect,
        );
        expect(terminalResume.status).toBe(409);
        expect(yield* sdkCall(() => terminalResume.json())).toEqual({
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
        const queuedResume = yield* Effect.provideContext(
          chatApi.requestTraceResume(session.id, null, trace.task_id, trace.attempt_id, false),
          yield* runtime.contextEffect,
        );
        expect(queuedResume.status).toBe(202);
        expect(yield* sdkCall(() => queuedResume.json())).toMatchObject({
          status: "queued",
          taskId: trace.task_id,
          expectedAttemptId: trace.attempt_id,
        });
        const streamResponse = yield* Effect.provideContext(
          chatApi.traceStream(new Request("http://local/trace/stream?after=0"), session.id),
          yield* runtime.contextEffect,
        );
        expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
        const reader = streamResponse.body!.getReader();
        yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()));
        const first = yield* sdkCall(() => reader.read());
        expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
        yield* sdkCall(() => reader.cancel());
        const invalidCursor = yield* Effect.provideContext(
          chatApi.traceStream(new Request("http://local/trace/stream?after=nope"), session.id),
          yield* runtime.contextEffect,
        );
        expect(invalidCursor.status).toBe(400);
      }).pipe(withTestPlatform),
  );

  it.live("subagent calls of one step run at the same time and answer in call order", () =>
    Effect.gen(function* () {
      const gate = turnGate();
      const started: string[] = [];
      const { send, state } = yield* subagentSetup("ask", {
        delayedTurnGate: gate.waitFor,
        responder: Effect.fn("subagentTest.responder")(function* (
          invocation: Parameters<typeof defaultTestResponder>[0],
        ) {
          const turn = yield* sdkCall(() => defaultTestResponder(invocation));
          if (isTruthy(turn.text?.startsWith("napped: nap "))) started.push(turn.text);
          return turn;
        }),
      });
      const pending = yield* Effect.forkChild(send("delegate twice"));
      try {
        // Both model calls must start while neither child can finish.
        yield* until(
          Effect.sync(() => started.length === 2),
          "both child model calls",
        );
        expect(started).toEqual(expect.arrayContaining(["napped: nap A", "napped: nap B"]));
      } finally {
        gate.release();
        yield* Fiber.join(pending);
      }
      const answer = yield* Fiber.join(pending);
      expect(answer.indexOf("napped: nap A")).toBeGreaterThan(-1);
      expect(answer.indexOf("napped: nap A")).toBeLessThan(answer.indexOf("napped: nap B"));
      expect(state().subagents.map((child) => child.status)).toEqual(["completed", "completed"]);
    }).pipe(withTestPlatform),
  );

  it.live("a named child keeps its own conversation across the session's runs", () =>
    Effect.gen(function* () {
      const { send, state } = yield* subagentSetup();
      yield* send('call message_subagent {"agent":"helper","message":"first task"}');
      const second = yield* send(
        'call message_subagent {"agent":"helper","message":"second task"}',
      );
      expect(second).toContain("child done: second task (earlier user messages: 1)");
      const children = state().subagents;
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ name: "helper", lastTask: "second task" });
    }).pipe(withTestPlatform),
  );

  it.live("a child's gated call waits for the user on the page, and a denial never runs it", () =>
    Effect.gen(function* () {
      const { send, subagents, relayed, session, state, runtime } = yield* subagentSetup("ask");
      const approved = yield* Effect.forkChild(
        send('call run_subagent {"task":"shell: printf child-approved"}'),
      );
      yield* until(
        Effect.sync(() => state().approvals.length === 1),
        "the child's approval",
      );
      const [request] = state().approvals;
      expect(request).toMatchObject({
        toolName: "run_shell",
        askedBy: "every_call",
        requester: { kind: "subagent", name: null },
      });
      expect(yield* relayed.answer("another-session", request!.id, true)).toBe(false);
      expect(yield* relayed.answer(session.id, request!.id, true)).toBe(true);
      const approvedAnswer = yield* Fiber.join(approved);
      expect(approvedAnswer).toContain("child-approved");
      expect(approvedAnswer).toContain("exitCode");
      const denied = yield* Effect.forkChild(
        send('call run_subagent {"task":"shell: printf child-denied"}'),
      );
      yield* until(
        Effect.sync(() => state().approvals.length === 1),
        "the second approval",
      );
      yield* relayed.answer(session.id, state().approvals[0]!.id, false);
      const deniedAnswer = yield* Fiber.join(denied);
      expect(deniedAnswer).toContain("User denied this action");
      expect(deniedAnswer).not.toContain("exitCode");
      const reviews = yield* Effect.provideContext(PermissionReviews, yield* runtime.contextEffect);
      const children = state().subagents;
      expect(reviews.latest(session.id, `subagent-${children[0]!.id}:call-shell`)?.decision).toBe(
        "approved",
      );
      expect(reviews.latest(session.id, `subagent-${children[1]!.id}:call-shell`)?.decision).toBe(
        "denied",
      );
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
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
        const transcript = yield* sdkCall(() => subagents.transcript(session.id, child.id));
        const persisted = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          transcript?.messages ?? [],
        );
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
          const toolCallId = (yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ toolCallId: Schema.String })),
          )(locator)).toolCallId;
          expect(persisted).toContain(toolCallId);
        }
      }
    }).pipe(withTestPlatform),
  );

  it.live("a child file write records the actual artifact without copying its contents", () =>
    Effect.gen(function* () {
      const { send, state, runtime } = yield* subagentSetup("full");
      const answer = yield* send(
        'call run_subagent {"task":"call write_file {\\"path\\":\\"wt-artifact.txt\\",\\"content\\":\\"artifact sentinel body\\"}"}',
      );
      expect(answer).toContain("write_file said");
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      const artifact = yield* Schema.decodeUnknownEffect(ArtifactSummary)(
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
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          evidence: db.sqlite.prepare("SELECT * FROM evidence_refs").all(),
          artifacts: db.sqlite.prepare("SELECT * FROM work_artifacts").all(),
        }),
      ).not.toContain("artifact sentinel body");
    }).pipe(withTestPlatform),
  );

  it.live("resume_subagent runs a new child attempt from the durable checkpoint", () =>
    Effect.gen(function* () {
      const { send, session, runtime } = yield* subagentSetup();
      yield* send('call run_subagent {"task":"collect facts"}');
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      const ids = yield* Schema.decodeUnknownEffect(ResumeIds)(
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
      const resumed = yield* send(
        `call resume_subagent ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ taskId: ids.task_id, expectedAttemptId: ids.attempt_id })}`,
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
    }).pipe(withTestPlatform),
  );

  it.live("restart recovery stays blocked when the checkpoint has an uncertain side effect", () =>
    Effect.gen(function* () {
      const { send, session, runtime, reopen } = yield* subagentSetup();
      yield* send('call run_subagent {"task":"write externally"}');
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      const ids = yield* Schema.decodeUnknownEffect(ResumeIds)(
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
      const reopened = yield* sdkCall(() => reopen());
      const reopenedDb = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
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
      const reopenedAgent = yield* Effect.provideContext(AgentChat, yield* reopened.contextEffect);
      const response = yield* Effect.provideContext(
        reopenedAgent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: session.id,
              runId: "blocked-recovery-parent",
              messages: [{ id: "blocked-turn", role: "user", content: "continue" }],
              tools: [],
              context: [],
            }),
          }),
          session.id,
        ),
        yield* reopened.contextEffect,
      );
      yield* sdkCall(() => response.text());
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
    }).pipe(withTestPlatform),
  );

  it.live("cancelling the parent stops a waiting child, and a restart never reruns one", () =>
    Effect.gen(function* () {
      const { send, session, state, runtime, reopen } = yield* subagentSetup("ask");
      const run = yield* Effect.forkChild(
        send('call run_subagent {"task":"shell: printf never-runs"}'),
      );
      yield* until(
        Effect.sync(() => state().approvals.length === 1),
        "the child's approval",
      );
      const cancel = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
        yield* runtime.contextEffect,
      );
      expect(cancel.status).toBe(200);
      yield* Fiber.join(run);
      yield* until(
        Effect.sync(() => state().subagents[0]?.status === "cancelled"),
        "the child to stop",
      );
      expect(state().approvals).toEqual([]);
      // Create a safe checkpoint with no uncertain tool side effects, then simulate a crash while that
      // newest child attempt is still running.
      yield* send('call run_subagent {"task":"recover facts"}');
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
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
      const reopened = yield* sdkCall(() => reopen());
      const after = yield* Effect.provideContext(
        Effect.map(Subagents, (s) => s.list(session.id)),
        yield* reopened.contextEffect,
      );
      expect(after[0]?.status).toBe("interrupted");
      const reopenedDb = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
      const restartedTrace = yield* Schema.decodeUnknownEffect(RestartedTrace)(
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
          .prepare(
            "SELECT status, blocker FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ status: "queued", blocker: null });
      const reopenedAgent = yield* Effect.provideContext(AgentChat, yield* reopened.contextEffect);
      const recoveryParentRun = "recovery-parent-run";
      const recoveryResponse = yield* Effect.provideContext(
        reopenedAgent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: session.id,
              runId: recoveryParentRun,
              messages: [{ id: "recovery-turn", role: "user", content: "continue" }],
              tools: [],
              context: [],
            }),
          }),
          session.id,
        ),
        yield* reopened.contextEffect,
      );
      yield* sdkCall(() => recoveryResponse.text());
      yield* until(
        Effect.gen(function* () {
          return ["completed", "failed", "blocked"].includes(
            (yield* Schema.decodeUnknownEffect(JobStatus)(
              reopenedDb.sqlite
                .prepare("SELECT status FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1")
                .get(),
            )).status,
          );
        }),
        "the recovery job to finish",
      );
      expect(
        (yield* Schema.decodeUnknownEffect(JobStatus)(
          reopenedDb.sqlite
            .prepare("SELECT status FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1")
            .get(),
        )).status,
      ).toBe("completed");
      expect(
        reopenedDb.sqlite
          .prepare(
            `SELECT count(*) AS attempts FROM agent_run_attempts
           WHERE task_id = (SELECT task_id FROM work_recovery_jobs ORDER BY created_at DESC LIMIT 1)`,
          )
          .get(),
      ).toEqual({ attempts: 2 });
      const reopenedTrace = yield* Effect.provideContext(
        WorkTraceStore,
        yield* reopened.contextEffect,
      );
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
    }).pipe(withTestPlatform),
  );
});
