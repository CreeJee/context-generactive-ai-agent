import { Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";

const AttemptLineage = Schema.Struct({
  id: Schema.String,
  attempt_number: Schema.Number,
  chat_run_id: Schema.String,
  status: Schema.String,
  resumed_from_attempt_id: Schema.NullOr(Schema.String),
  superseded_by_attempt_id: Schema.NullOr(Schema.String),
});
const decodeLineage = Schema.decodeUnknownSync(Schema.Array(AttemptLineage));

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};
const run = <A>(effect: Effect.Effect<A, never, Database | WorkTraceStore>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(testLayer()))));

const seed = (db: Database["Service"]) => {
  const iso = new Date(0).toISOString();
  db.sqlite
    .prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)")
    .run(iso);
  db.sqlite
    .prepare(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    )
    .run(iso);
  db.sqlite
    .prepare(
      `INSERT INTO subagents
       (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
       VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`,
    )
    .run();
};

const interruptedAttempt = (
  trace: WorkTraceStore["Service"],
  uncertain: readonly string[] = [],
) => {
  const handle = trace.startAttempt({
    sessionId: "s1",
    parentRunId: "parent-1",
    parentToolCallId: "call-1",
    agentId: "agent-1",
    title: "Research",
    request: "Research the code",
    kind: "start",
    threadId: "subagent-agent-1",
  });
  trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
  trace.checkpoint("s1", {
    handle,
    completedToolCallIds: ["tool-complete"],
    uncertainToolCallIds: uncertain,
    pendingApprovalIds: ["approval-expired"],
    remainingWork: "Write the verified report.",
  });
  trace.transitionAttempt(handle, "s1", "interrupted", "attempt_interrupted", "Server restarted");
  return handle;
};

describe("Work Trace logical resume", () => {
  test("creates a new child run under the same task and rejects a duplicate active resume", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const previous = interruptedAttempt(trace);
        const resumed = trace.claimResume({
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
          remainingWork: "Write the verified report.",
          completedToolCallIds: ["tool-complete"],
          uncertainToolCallIds: [],
          expiredApprovalIds: ["approval-expired"],
          checkpointId: expect.any(String),
        });

        expect(
          trace.claimResume({
            sessionId: "s1",
            taskId: previous.taskId,
            expectedAttemptId: previous.id,
            parentRunId: "parent-3",
            parentToolCallId: "call-resume-2",
            confirmUncertain: false,
          }),
        ).toEqual({ status: "blocked", reason: "attempt_alive" });

        expect(
          decodeLineage(
            db.sqlite
              .prepare(
                `SELECT id, attempt_number, chat_run_id, status, resumed_from_attempt_id,
                        superseded_by_attempt_id
                 FROM agent_run_attempts WHERE task_id = ? ORDER BY attempt_number`,
              )
              .all(previous.taskId),
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
    );
  });

  test("only one parent run can claim a queued automatic recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
        trace.checkpoint("s1", {
          handle,
          completedToolCallIds: ["tool-complete"],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "Finish the report.",
        });
        trace.transitionAttempt(handle, "s1", "interrupted", "attempt_interrupted", "Interrupted");
        db.sqlite
          .prepare(
            `INSERT INTO work_recovery_jobs
             (id, project_id, task_id, interrupted_attempt_id, status, blocker,
              created_at, updated_at)
             VALUES ('job-1', 'p1', ?, ?, 'queued', NULL, 1, 1)`,
          )
          .run(handle.taskId, handle.id);

        const first = trace.claimRecoveryJobs("s1", "parent-recovery-1");
        const second = trace.claimRecoveryJobs("s1", "parent-recovery-2");
        expect(first).toHaveLength(1);
        expect(first[0]?.claim.handle.attemptNumber).toBe(2);
        expect(second).toEqual([]);
        expect(
          db.sqlite
            .prepare("SELECT status, claimed_by FROM work_recovery_jobs WHERE id = 'job-1'")
            .get(),
        ).toEqual({ status: "claimed", claimed_by: "parent-recovery-1" });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS attempts FROM agent_run_attempts WHERE task_id = ?")
            .get(handle.taskId),
        ).toEqual({ attempts: 2 });
      }),
    );
  });

  test("requires explicit confirmation when a checkpoint has uncertain side effects", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const previous = interruptedAttempt(trace, ["tool-uncertain"]);
        const input = {
          sessionId: "s1",
          taskId: previous.taskId,
          expectedAttemptId: previous.id,
          parentRunId: "parent-2",
          parentToolCallId: "call-resume-1",
        } as const;
        expect(trace.claimResume({ ...input, confirmUncertain: false })).toEqual({
          status: "blocked",
          reason: "uncertain_side_effect",
        });
        const confirmed = trace.claimResume({ ...input, confirmUncertain: true });
        expect(confirmed.status).toBe("started");
        if (confirmed.status === "started")
          expect(confirmed.context.uncertainToolCallIds).toEqual(["tool-uncertain"]);
      }),
    );
  });

  test("a confirmed server resume request is durably queued and claimed by one parent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const previous = interruptedAttempt(trace, ["tool-uncertain"]);
        const request = {
          sessionId: "s1",
          taskId: previous.taskId,
          expectedAttemptId: previous.id,
        } as const;
        expect(trace.requestResume({ ...request, confirmUncertain: false })).toEqual({
          status: "blocked",
          reason: "uncertain_side_effect",
        });
        const queued = trace.requestResume({ ...request, confirmUncertain: true });
        expect(queued).toMatchObject({
          status: "queued",
          taskId: previous.taskId,
          expectedAttemptId: previous.id,
        });
        expect(
          db.sqlite
            .prepare("SELECT status, confirm_uncertain FROM work_recovery_jobs WHERE task_id = ?")
            .get(previous.taskId),
        ).toEqual({ status: "queued", confirm_uncertain: 1 });

        const [claimed] = trace.claimRecoveryJobs("s1", "parent-http-resume");
        expect(claimed?.claim.status).toBe("started");
        if (claimed?.claim.status === "started")
          expect(claimed.claim.context.uncertainToolCallIds).toEqual(["tool-uncertain"]);
        expect(trace.claimRecoveryJobs("s1", "parent-race")).toEqual([]);
      }),
    );
  });

  test("project review keeps task detail after the origin session and agent are deleted", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = interruptedAttempt(trace);
        db.sqlite.prepare("DELETE FROM subagents WHERE id = 'agent-1'").run();
        db.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run();

        expect(trace.taskTree("s1")).toEqual([]);
        expect(trace.projectLatestCursor("p1")).toBeGreaterThan(0);
        expect(trace.projectTaskTree("p1")).toEqual([
          expect.objectContaining({
            id: handle.taskId,
            projectId: "p1",
            originSessionId: null,
            agentId: null,
            agentName: "researcher",
          }),
        ]);
        expect(trace.projectTaskDetail("p1", handle.taskId)).toMatchObject({
          task: { id: handle.taskId, originSessionId: null },
          attempts: [{ id: handle.id, status: "interrupted" }],
          events: expect.arrayContaining([expect.objectContaining({ taskId: handle.taskId })]),
        });
        expect(trace.projectTaskDetail("another-project", handle.taskId)).toBeNull();
      }),
    );
  });

  test("archives only a settled task and keeps its trace while blocking resume", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = interruptedAttempt(trace);

        expect(trace.archiveTask("s1", handle.taskId)).toEqual({
          status: "archived",
          taskId: handle.taskId,
        });
        expect(trace.taskTree("s1")[0]?.status).toBe("archived");
        expect(trace.taskDetail("s1", handle.taskId)?.attempts).toHaveLength(1);
        expect(
          trace.claimResume({
            sessionId: "s1",
            taskId: handle.taskId,
            expectedAttemptId: handle.id,
            parentRunId: "parent-2",
            parentToolCallId: "resume-call",
            confirmUncertain: false,
          }),
        ).toEqual({ status: "blocked", reason: "task_archived" });
      }),
    );
  });

  test("rejects stale attempt ids and tasks without a durable checkpoint", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
        trace.transitionAttempt(handle, "s1", "failed", "attempt_failed", "Failed");
        const base = {
          sessionId: "s1",
          taskId: handle.taskId,
          parentRunId: "parent-2",
          parentToolCallId: "call-2",
          confirmUncertain: false,
        } as const;
        expect(trace.claimResume({ ...base, expectedAttemptId: "stale" })).toEqual({
          status: "blocked",
          reason: "stale_attempt",
        });
        expect(trace.claimResume({ ...base, expectedAttemptId: handle.id })).toEqual({
          status: "blocked",
          reason: "missing_checkpoint",
        });
      }),
    );
  });
});
