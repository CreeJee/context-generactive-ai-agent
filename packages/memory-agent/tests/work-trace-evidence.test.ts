import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";

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
    .prepare(`INSERT INTO subagents
    (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
    VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`)
    .run();
};
const start = (trace: WorkTraceStore["Service"]) =>
  trace.startAttempt({
    sessionId: "s1",
    parentRunId: "parent-1",
    parentToolCallId: "call-1",
    agentId: "agent-1",
    title: "Research",
    request: "Research the code",
    kind: "start",
    threadId: "subagent-agent-1",
  });

describe("Work Trace evidence and artifact provenance", () => {
  test("stores typed locators without source payloads and projects them by task", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        const message = trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
        });
        const duplicate = trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
        });
        trace.recordEvidence({
          handle,
          locator: { kind: "tool_result", threadId: handle.threadId, toolCallId: "tool-1" },
          verification: "verified",
        });
        const checkpoint = trace.checkpoint("s1", {
          handle,
          completedToolCallIds: [],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "",
        });
        const hidden = trace.recordEvidence({
          handle,
          locator: { kind: "checkpoint", checkpointId: checkpoint.checkpointId },
          redaction: "redacted",
        });
        const artifact = trace.recordArtifact({
          handle,
          kind: "file",
          locator: { kind: "file", path: "reports/result.md", sha256: "a".repeat(64) },
          mediaType: "text/markdown",
          verification: "verified",
        });

        expect(duplicate.id).toBe(message.id);
        expect(trace.taskDetail("s1", handle.taskId)).toEqual(
          expect.objectContaining({
            evidence: expect.arrayContaining([
              expect.objectContaining({ id: message.id, locator: message.locator }),
              expect.objectContaining({ sourceKind: "tool_result", verification: "verified" }),
              expect.objectContaining({ id: hidden.id, locator: null, redaction: "redacted" }),
            ]),
            artifacts: [expect.objectContaining({ id: artifact.id, mediaType: "text/markdown" })],
          }),
        );
        const persisted = JSON.stringify({
          evidence: db.sqlite.prepare("SELECT * FROM evidence_refs").all(),
          artifacts: db.sqlite.prepare("SELECT * FROM work_artifacts").all(),
        });
        expect(persisted).not.toContain("secret transcript body");
        expect(persisted).not.toContain("tool result contents");
      }),
    );
  });

  test("uses explicit states and clears locator metadata in source-deleted tombstones", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        const evidence = trace.recordEvidence({
          handle,
          locator: { kind: "file", path: "private/report.md", sha256: "b".repeat(64) },
        });
        const artifact = trace.recordArtifact({
          handle,
          kind: "external",
          locator: { kind: "external", reference: "private-object-17" },
          mediaType: "application/json",
        });
        expect(trace.setEvidenceVerification(evidence.id, "invalidated")?.verification).toBe(
          "invalidated",
        );
        expect(trace.setArtifactVerification(artifact.id, "unavailable")?.verification).toBe(
          "unavailable",
        );
        expect(trace.markEvidenceSourceDeleted(evidence.id)).toEqual(
          expect.objectContaining({ locator: null, verification: "source_deleted" }),
        );
        expect(trace.markArtifactSourceDeleted(artifact.id)).toEqual(
          expect.objectContaining({
            locator: null,
            mediaType: null,
            verification: "source_deleted",
          }),
        );
        const raw = JSON.stringify({
          evidence: db.sqlite.prepare("SELECT * FROM evidence_refs WHERE id = ?").get(evidence.id),
          artifact: db.sqlite.prepare("SELECT * FROM work_artifacts WHERE id = ?").get(artifact.id),
        });
        expect(raw).not.toContain("private/report.md");
        expect(raw).not.toContain("private-object-17");
        expect(raw).not.toContain("application/json");
      }),
    );
  });

  test("keeps project provenance after origin deletion and rejects unsafe file locators", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
        });
        trace.recordArtifact({
          handle,
          kind: "generated",
          locator: { kind: "generated", reference: "artifact-store:item-1" },
        });
        expect(() =>
          trace.recordEvidence({
            handle,
            locator: { kind: "file", path: "/tmp/secret", sha256: "c".repeat(64) },
          }),
        ).toThrow("project-relative");
        expect(() =>
          trace.recordArtifact({
            handle,
            kind: "file",
            locator: { kind: "file", path: "../secret", sha256: "not-a-digest" },
          }),
        ).toThrow();
        expect(() =>
          trace.recordEvidence({
            handle,
            locator: { kind: "message", threadId: "another-thread", messageId: "message-1" },
          }),
        ).toThrow("another thread");
        const other = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-2",
          agentId: "agent-1",
          title: "Other",
          request: "Other work",
          kind: "start",
          threadId: "subagent-agent-1-other",
        });
        const otherCheckpoint = trace.checkpoint("s1", {
          handle: other,
          completedToolCallIds: [],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "",
        });
        expect(() =>
          trace.recordEvidence({
            handle,
            locator: { kind: "checkpoint", checkpointId: otherCheckpoint.checkpointId },
          }),
        ).toThrow("does not belong");
        db.sqlite.prepare("DELETE FROM subagents WHERE id = 'agent-1'").run();
        db.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run();
        expect(trace.taskDetail("s1", handle.taskId)).toBeNull();
        expect(trace.projectTaskDetail("p1", handle.taskId)).toEqual(
          expect.objectContaining({
            evidence: [expect.any(Object)],
            artifacts: [expect.any(Object)],
          }),
        );
        expect(trace.projectTaskDetail("other", handle.taskId)).toBeNull();
      }),
    );
  });
});

describe("Work Trace report adoption", () => {
  test("links a final answer to the used report, verified evidence, and reflected notification", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        const evidence = trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "child-answer" },
          verification: "verified",
        });
        trace.recordReportDisposition({
          handle,
          sessionId: "s1",
          disposition: "returned",
          parentRunId: "parent-1",
        });
        trace.recordReportDisposition({
          handle,
          sessionId: "s1",
          disposition: "reviewed",
          parentRunId: "parent-1",
        });
        const notificationId = trace.notifyParent({
          taskId: handle.taskId,
          kind: "completed",
          summary: "Subagent completed",
          idempotencyKey: "test:completed",
          deliveredImmediately: true,
        });
        expect(notificationId).not.toBeNull();
        const claimId = trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
          usedReports: [
            { taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] },
          ],
          reflectedNotificationIds: [notificationId!],
        });
        expect(
          trace.finalizeAnswerClaim({
            projectId: "p1",
            sessionId: "s1",
            parentRunId: "parent-1",
            parentMessageId: "parent-answer",
            usedReports: [
              { taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] },
            ],
            reflectedNotificationIds: [notificationId!],
          }),
        ).toBe(claimId);
        const detail = trace.taskDetail("s1", handle.taskId)!;
        expect(detail.adoptions.map((item) => item.disposition)).toEqual([
          "returned",
          "reviewed",
          "used",
        ]);
        expect(detail.adoptions.at(-1)).toMatchObject({
          claimId,
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
        });
        expect(detail.answerClaims).toEqual([
          expect.objectContaining({
            id: claimId,
            parentMessageId: "parent-answer",
            notificationIds: [notificationId],
            sources: [
              {
                taskId: handle.taskId,
                attemptId: handle.id,
                evidenceRefId: evidence.id,
              },
            ],
          }),
        ]);
      }),
    );
  });

  test("records an omitted reviewed report as not used and rejects unreviewed use", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        expect(() =>
          trace.finalizeAnswerClaim({
            projectId: "p1",
            sessionId: "s1",
            parentRunId: "parent-1",
            parentMessageId: "invalid-answer",
            usedReports: [{ taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [] }],
            reflectedNotificationIds: [],
          }),
        ).toThrow("unreviewed report");
        trace.recordReportDisposition({
          handle,
          sessionId: "s1",
          disposition: "reviewed",
          parentRunId: "parent-1",
        });
        trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
          usedReports: [],
          reflectedNotificationIds: [],
        });
        expect(
          trace.taskDetail("s1", handle.taskId)!.adoptions.map((item) => item.disposition),
        ).toEqual(["reviewed", "not_used"]);
      }),
    );
  });
});
