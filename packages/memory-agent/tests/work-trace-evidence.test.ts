import { DateTime, Schema, Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};
const run = Effect.fnUntraced(function* <A, E>(
  program: Effect.Effect<A, E, Database | WorkTraceStore>,
) {
  const services = yield* Layer.build(testLayer());
  return yield* Effect.provideContext(program, services);
}, Effect.scoped);
const seed = (db: Database["Service"]) => {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(0));
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
  it.effect("stores typed locators without source payloads and projects them by task", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = yield* start(trace);
        const message = yield* trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
        });
        const duplicate = yield* trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
        });
        yield* trace.recordEvidence({
          handle,
          locator: { kind: "tool_result", threadId: handle.threadId, toolCallId: "tool-1" },
          verification: "verified",
        });
        const checkpoint = yield* trace.checkpoint("s1", {
          handle,
          completedToolCallIds: [],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "",
        });
        const hidden = yield* trace.recordEvidence({
          handle,
          locator: { kind: "checkpoint", checkpointId: checkpoint.checkpointId },
          redaction: "redacted",
        });
        const artifact = yield* trace.recordArtifact({
          handle,
          kind: "file",
          locator: { kind: "file", path: "reports/result.md", sha256: "a".repeat(64) },
          mediaType: "text/markdown",
          verification: "verified",
        });

        expect(duplicate.id).toBe(message.id);
        expect(yield* trace.taskDetail("s1", handle.taskId)).toEqual(
          expect.objectContaining({
            evidence: expect.arrayContaining([
              expect.objectContaining({ id: message.id, locator: message.locator }),
              expect.objectContaining({ sourceKind: "tool_result", verification: "verified" }),
              expect.objectContaining({ id: hidden.id, locator: null, redaction: "redacted" }),
            ]),
            artifacts: [expect.objectContaining({ id: artifact.id, mediaType: "text/markdown" })],
          }),
        );
        const persisted = yield* stringifyJson({
          evidence: db.sqlite.prepare("SELECT * FROM evidence_refs").all(),
          artifacts: db.sqlite.prepare("SELECT * FROM work_artifacts").all(),
        });
        expect(persisted).not.toContain("secret transcript body");
        expect(persisted).not.toContain("tool result contents");
      }),
    ),
  );

  it.effect("uses explicit states and clears locator metadata in source-deleted tombstones", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = yield* start(trace);
        const evidence = yield* trace.recordEvidence({
          handle,
          locator: { kind: "file", path: "private/report.md", sha256: "b".repeat(64) },
        });
        const artifact = yield* trace.recordArtifact({
          handle,
          kind: "external",
          locator: { kind: "external", reference: "private-object-17" },
          mediaType: "application/json",
        });
        expect(
          (yield* trace.setEvidenceVerification(evidence.id, "invalidated"))?.verification,
        ).toBe("invalidated");
        expect(
          (yield* trace.setArtifactVerification(artifact.id, "unavailable"))?.verification,
        ).toBe("unavailable");
        expect(yield* trace.markEvidenceSourceDeleted(evidence.id)).toEqual(
          expect.objectContaining({ locator: null, verification: "source_deleted" }),
        );
        expect(yield* trace.markArtifactSourceDeleted(artifact.id)).toEqual(
          expect.objectContaining({
            locator: null,
            mediaType: null,
            verification: "source_deleted",
          }),
        );
        const raw = yield* stringifyJson({
          evidence: db.sqlite.prepare("SELECT * FROM evidence_refs WHERE id = ?").get(evidence.id),
          artifact: db.sqlite.prepare("SELECT * FROM work_artifacts WHERE id = ?").get(artifact.id),
        });
        expect(raw).not.toContain("private/report.md");
        expect(raw).not.toContain("private-object-17");
        expect(raw).not.toContain("application/json");
      }),
    ),
  );

  it.effect("keeps project provenance after origin deletion and rejects unsafe file locators", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = yield* start(trace);
        yield* trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
        });
        yield* trace.recordArtifact({
          handle,
          kind: "generated",
          locator: { kind: "generated", reference: "artifact-store:item-1" },
        });
        expect(
          yield* Effect.flip(
            trace.recordEvidence({
              handle,
              locator: { kind: "file", path: "/tmp/secret", sha256: "c".repeat(64) },
            }),
          ),
        ).toMatchObject({ reason: "unsafe_file_path" });
        expect(
          yield* Effect.flip(
            trace.recordArtifact({
              handle,
              kind: "file",
              locator: { kind: "file", path: "../secret", sha256: "not-a-digest" },
            }),
          ),
        ).toMatchObject({ reason: "unsafe_file_path" });
        expect(
          yield* Effect.flip(
            trace.recordEvidence({
              handle,
              locator: { kind: "message", threadId: "another-thread", messageId: "message-1" },
            }),
          ),
        ).toMatchObject({ reason: "foreign_thread" });
        const other = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-2",
          agentId: "agent-1",
          title: "Other",
          request: "Other work",
          kind: "start",
          threadId: "subagent-agent-1-other",
        });
        const otherCheckpoint = yield* trace.checkpoint("s1", {
          handle: other,
          completedToolCallIds: [],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "",
        });
        expect(
          yield* Effect.flip(
            trace.recordEvidence({
              handle,
              locator: { kind: "checkpoint", checkpointId: otherCheckpoint.checkpointId },
            }),
          ),
        ).toMatchObject({ reason: "foreign_checkpoint" });
        db.sqlite.prepare("DELETE FROM subagents WHERE id = 'agent-1'").run();
        db.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run();
        expect(yield* trace.taskDetail("s1", handle.taskId)).toBeNull();
        expect(yield* trace.projectTaskDetail("p1", handle.taskId)).toEqual(
          expect.objectContaining({
            evidence: [expect.any(Object)],
            artifacts: [expect.any(Object)],
          }),
        );
        expect(yield* trace.projectTaskDetail("other", handle.taskId)).toBeNull();
      }),
    ),
  );
});

describe("Work Trace report adoption", () => {
  it.effect(
    "links a final answer to the used report, verified evidence, and reflected notification",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* Database;
          const trace = yield* WorkTraceStore;
          seed(db);
          const handle = yield* start(trace);
          const evidence = yield* trace.recordEvidence({
            handle,
            locator: { kind: "message", threadId: handle.threadId, messageId: "child-answer" },
            verification: "verified",
          });
          yield* trace.recordReportDisposition({
            handle,
            sessionId: "s1",
            disposition: "returned",
            parentRunId: "parent-1",
          });
          yield* trace.recordReportDisposition({
            handle,
            sessionId: "s1",
            disposition: "reviewed",
            parentRunId: "parent-1",
          });
          const notificationId = yield* trace.notifyParent({
            taskId: handle.taskId,
            kind: "completed",
            summary: "Subagent completed",
            idempotencyKey: "test:completed",
            deliveredImmediately: true,
          });
          expect(notificationId).not.toBeNull();
          const claimId = yield* trace.finalizeAnswerClaim({
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
            yield* trace.finalizeAnswerClaim({
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
          const detail = (yield* trace.taskDetail("s1", handle.taskId))!;
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
      ),
  );

  it.effect("records an omitted reviewed report as not used and rejects unreviewed use", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = yield* start(trace);
        const unreviewed = yield* Effect.flip(
          trace.finalizeAnswerClaim({
            projectId: "p1",
            sessionId: "s1",
            parentRunId: "parent-1",
            parentMessageId: "invalid-answer",
            usedReports: [{ taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [] }],
            reflectedNotificationIds: [],
          }),
        );
        expect(unreviewed).toMatchObject({
          _tag: "WorkTraceRejected",
          reason: "unreviewed_report",
        });
        yield* trace.recordReportDisposition({
          handle,
          sessionId: "s1",
          disposition: "reviewed",
          parentRunId: "parent-1",
        });
        yield* trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
          usedReports: [],
          reflectedNotificationIds: [],
        });
        expect(
          (yield* trace.taskDetail("s1", handle.taskId))!.adoptions.map((item) => item.disposition),
        ).toEqual(["reviewed", "not_used"]);
      }),
    ),
  );
});
