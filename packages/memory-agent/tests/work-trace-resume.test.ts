import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore, type AttemptHandle } from "../src/work-trace/store.ts";
import { sqlAll, sqlGet, sqlRun } from "./support/sql.ts";

const AttemptLineage = Schema.Struct({
  id: Schema.String,
  attempt_number: Schema.Finite,
  chat_run_id: Schema.String,
  status: Schema.String,
  resumed_from_attempt_id: Schema.NullOr(Schema.String),
  superseded_by_attempt_id: Schema.NullOr(Schema.String),
});
const decodeLineage = Schema.decodeUnknownEffect(Schema.Array(AttemptLineage));

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};
const run = Effect.fnUntraced(function* <A, E>(
  program: Effect.Effect<A, E, SqlClient.SqlClient | WorkTraceStore>,
) {
  const services = yield* Layer.build(testLayer());
  return yield* Effect.provideContext(program, services);
}, Effect.scoped);

const seed = Effect.fnUntraced(function* () {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(0));
  yield* sqlRun(
    "INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)",
    iso,
  );
  yield* sqlRun(
    "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    iso,
  );
  yield* sqlRun(
    `INSERT INTO subagents
       (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
       VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`,
  );
});

const toolCall = Effect.fnUntraced(function* (
  trace: WorkTraceStore["Service"],
  handle: AttemptHandle,
  toolCallId: string,
  settled: boolean,
) {
  const payload = { toolCallId, toolName: "write_file" };
  yield* trace.appendEvent({
    handle,
    sessionId: "s1",
    kind: "tool_requested",
    summary: "Requested",
    payload,
  });
  if (settled)
    yield* trace.appendEvent({
      handle,
      sessionId: "s1",
      kind: "tool_completed",
      summary: "Completed",
      payload,
    });
});

const interruptedAttempt = Effect.fnUntraced(function* (
  trace: WorkTraceStore["Service"],
  uncertain: readonly string[] = [],
) {
  const handle = yield* trace.startAttempt({
    sessionId: "s1",
    parentRunId: "parent-1",
    parentToolCallId: "call-1",
    agentId: "agent-1",
    title: "Research",
    request: "Research the code",
    kind: "start",
    threadId: "subagent-agent-1",
  });
  yield* trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
  yield* toolCall(trace, handle, "tool-complete", true);
  for (const toolCallId of uncertain) yield* toolCall(trace, handle, toolCallId, false);
  yield* trace.transitionAttempt(
    handle,
    "s1",
    "interrupted",
    "attempt_interrupted",
    "Server restarted",
  );
  return handle;
});

describe("Work Trace logical resume", () => {
  it.effect(
    "creates a new child run under the same task and rejects a duplicate active resume",
    () =>
      run(
        Effect.gen(function* () {
          const trace = yield* WorkTraceStore;
          yield* seed();
          const previous = yield* interruptedAttempt(trace);
          const resumed = yield* trace.claimResume({
            sessionId: "s1",
            taskId: previous.taskId,
            expectedAttemptId: previous.id,
            parentRunId: "parent-2",
            parentToolCallId: "call-resume-1",
            confirmUncertain: false,
          });
          expect(resumed.status).toBe("started");
          if (resumed.status !== "started") return;
          expect(resumed.handle.taskId).toBe(previous.taskId);
          expect(resumed.handle.id).not.toBe(previous.id);
          expect(resumed.handle.chatRunId).not.toBe(previous.chatRunId);
          expect(resumed.context).toEqual({
            originalRequest: "Research the code",
            completedToolCallIds: ["tool-complete"],
            uncertainToolCallIds: [],
          });

          expect(
            yield* trace.claimResume({
              sessionId: "s1",
              taskId: previous.taskId,
              expectedAttemptId: previous.id,
              parentRunId: "parent-3",
              parentToolCallId: "call-resume-2",
              confirmUncertain: false,
            }),
          ).toEqual({ status: "blocked", reason: "attempt_alive" });

          expect(
            yield* decodeLineage(
              yield* sqlAll(
                `SELECT id, attempt_number, chat_run_id, status, resumed_from_attempt_id,
                        superseded_by_attempt_id
                 FROM agent_run_attempts WHERE task_id = ? ORDER BY attempt_number`,
                previous.taskId,
              ),
            ),
          ).toEqual([
            {
              id: previous.id,
              attempt_number: 1,
              chat_run_id: previous.chatRunId,
              status: "interrupted",
              resumed_from_attempt_id: null,
              superseded_by_attempt_id: resumed.handle.id,
            },
            {
              id: resumed.handle.id,
              attempt_number: 2,
              chat_run_id: resumed.handle.chatRunId,
              status: "queued",
              resumed_from_attempt_id: previous.id,
              superseded_by_attempt_id: null,
            },
          ]);
        }),
      ),
  );

  it.effect("only one parent run can claim a queued automatic recovery", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        yield* trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
        yield* toolCall(trace, handle, "tool-complete", true);
        yield* trace.transitionAttempt(
          handle,
          "s1",
          "interrupted",
          "attempt_interrupted",
          "Interrupted",
        );
        yield* sqlRun(
          `INSERT INTO work_recovery_jobs
             (id, project_id, task_id, interrupted_attempt_id, status, blocker,
              created_at, updated_at)
             VALUES ('job-1', 'p1', ?, ?, 'queued', NULL, 1, 1)`,
          handle.taskId,
          handle.id,
        );

        const first = yield* trace.claimRecoveryJobs("s1", "parent-recovery-1");
        const second = yield* trace.claimRecoveryJobs("s1", "parent-recovery-2");
        expect(first).toHaveLength(1);
        expect(first[0]?.claim.handle.attemptNumber).toBe(2);
        expect(second).toEqual([]);
        expect(
          yield* sqlGet("SELECT status, claimed_by FROM work_recovery_jobs WHERE id = 'job-1'"),
        ).toEqual({ status: "claimed", claimed_by: "parent-recovery-1" });
        expect(
          yield* sqlGet(
            "SELECT count(*) AS attempts FROM agent_run_attempts WHERE task_id = ?",
            handle.taskId,
          ),
        ).toEqual({ attempts: 2 });
      }),
    ),
  );

  it.effect("requires explicit confirmation when a requested tool call never settled", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const previous = yield* interruptedAttempt(trace, ["tool-uncertain"]);
        const input = {
          sessionId: "s1",
          taskId: previous.taskId,
          expectedAttemptId: previous.id,
          parentRunId: "parent-2",
          parentToolCallId: "call-resume-1",
        } as const;
        expect(yield* trace.claimResume({ ...input, confirmUncertain: false })).toEqual({
          status: "blocked",
          reason: "uncertain_side_effect",
        });
        const confirmed = yield* trace.claimResume({ ...input, confirmUncertain: true });
        expect(confirmed.status).toBe("started");
        if (confirmed.status === "started")
          expect(confirmed.context.uncertainToolCallIds).toEqual(["tool-uncertain"]);
      }),
    ),
  );

  it.effect("a confirmed server resume request is durably queued and claimed by one parent", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const previous = yield* interruptedAttempt(trace, ["tool-uncertain"]);
        const request = {
          sessionId: "s1",
          taskId: previous.taskId,
          expectedAttemptId: previous.id,
        } as const;
        expect(yield* trace.requestResume({ ...request, confirmUncertain: false })).toEqual({
          status: "blocked",
          reason: "uncertain_side_effect",
        });
        const queued = yield* trace.requestResume({ ...request, confirmUncertain: true });
        expect(queued).toMatchObject({
          status: "queued",
          taskId: previous.taskId,
          expectedAttemptId: previous.id,
        });
        expect(
          yield* sqlGet(
            "SELECT status, confirm_uncertain FROM work_recovery_jobs WHERE task_id = ?",
            previous.taskId,
          ),
        ).toEqual({ status: "queued", confirm_uncertain: 1 });

        const [claimed] = yield* trace.claimRecoveryJobs("s1", "parent-http-resume");
        expect(claimed?.claim.status).toBe("started");
        if (claimed?.claim.status === "started")
          expect(claimed.claim.context.uncertainToolCallIds).toEqual(["tool-uncertain"]);
        expect(yield* trace.claimRecoveryJobs("s1", "parent-race")).toEqual([]);
      }),
    ),
  );

  it.effect("project review keeps task detail after the origin session and agent are deleted", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* interruptedAttempt(trace);
        yield* sqlRun("DELETE FROM subagents WHERE id = 'agent-1'");
        yield* sqlRun("DELETE FROM sessions WHERE id = 's1'");

        expect(yield* trace.taskTree("s1")).toEqual([]);
        expect(yield* trace.projectLatestCursor("p1")).toBeGreaterThan(0);
        expect(yield* trace.projectTaskTree("p1")).toEqual([
          expect.objectContaining({
            id: handle.taskId,
            projectId: "p1",
            originSessionId: null,
            agentId: null,
            agentName: "researcher",
          }),
        ]);
        expect(yield* trace.projectTaskDetail("p1", handle.taskId)).toMatchObject({
          task: { id: handle.taskId, originSessionId: null },
          attempts: [{ id: handle.id, status: "interrupted" }],
          events: expect.arrayContaining([expect.objectContaining({ taskId: handle.taskId })]),
        });
        expect(yield* trace.projectTaskDetail("another-project", handle.taskId)).toBeNull();
      }),
    ),
  );

  it.effect("archives only a settled task and keeps its trace while blocking resume", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* interruptedAttempt(trace);

        expect(yield* trace.archiveTask("s1", handle.taskId)).toEqual({
          status: "archived",
          taskId: handle.taskId,
        });
        expect((yield* trace.taskTree("s1"))[0]?.status).toBe("archived");
        expect((yield* trace.taskDetail("s1", handle.taskId))?.attempts).toHaveLength(1);
        expect(
          yield* trace.claimResume({
            sessionId: "s1",
            taskId: handle.taskId,
            expectedAttemptId: handle.id,
            parentRunId: "parent-2",
            parentToolCallId: "resume-call",
            confirmUncertain: false,
          }),
        ).toEqual({ status: "blocked", reason: "task_archived" });
      }),
    ),
  );

  it.effect("rejects stale attempt ids and retries a failed attempt without tool calls", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        yield* trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
        yield* trace.transitionAttempt(handle, "s1", "failed", "attempt_failed", "Failed");
        const base = {
          sessionId: "s1",
          taskId: handle.taskId,
          parentRunId: "parent-2",
          parentToolCallId: "call-2",
          confirmUncertain: false,
        } as const;
        expect(yield* trace.claimResume({ ...base, expectedAttemptId: "stale" })).toEqual({
          status: "blocked",
          reason: "stale_attempt",
        });
        expect(yield* trace.claimResume({ ...base, expectedAttemptId: handle.id })).toMatchObject({
          status: "started",
          context: {
            originalRequest: "Research",
            completedToolCallIds: [],
            uncertainToolCallIds: [],
          },
        });
      }),
    ),
  );
});
