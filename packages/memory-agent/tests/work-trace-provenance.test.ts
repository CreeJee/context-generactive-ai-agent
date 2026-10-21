import { DateTime, Schema, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../src/db/database.ts";
import { ArtifactLocator } from "../src/work-trace/contracts.ts";
import { WorkTraceRejected, WorkTraceStore } from "../src/work-trace/store.ts";
import { sqlAll, sqlGet, sqlRun } from "./support/sql.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  yield* sqlRun(`INSERT INTO subagents
    (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
    VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`);
});
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

describe("Work Trace artifact provenance", () => {
  it.effect("stores typed locators without source payloads and projects them by task", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* start(trace);
        const artifact = yield* trace.recordArtifact({
          handle,
          kind: "file",
          locator: ArtifactLocator.cases.file.make({
            path: "reports/result.md",
            sha256: "a".repeat(64),
          }),
          mediaType: "text/markdown",
          verification: "verified",
        });
        expect(yield* trace.taskDetail("s1", handle.taskId)).toEqual(
          expect.objectContaining({
            artifacts: [expect.objectContaining({ id: artifact.id, mediaType: "text/markdown" })],
          }),
        );
        const persisted = yield* stringifyJson(yield* sqlAll("SELECT * FROM work_artifacts"));
        expect(persisted).not.toContain("secret transcript body");
      }),
    ),
  );

  it.effect("uses explicit states and clears locator metadata in source-deleted tombstones", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* start(trace);
        const artifact = yield* trace.recordArtifact({
          handle,
          kind: "external",
          locator: ArtifactLocator.cases.external.make({ reference: "private-object-17" }),
          mediaType: "application/json",
        });
        expect(
          (yield* trace.setArtifactVerification(artifact.id, "unavailable"))?.verification,
        ).toBe("unavailable");
        expect(yield* trace.markArtifactSourceDeleted(artifact.id)).toEqual(
          expect.objectContaining({
            locator: null,
            mediaType: null,
            verification: "source_deleted",
          }),
        );
        const raw = yield* stringifyJson(
          yield* sqlGet("SELECT * FROM work_artifacts WHERE id = ?", artifact.id),
        );
        expect(raw).not.toContain("private-object-17");
        expect(raw).not.toContain("application/json");
      }),
    ),
  );

  it.effect("keeps project provenance after origin deletion and rejects unsafe file locators", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* start(trace);
        yield* trace.recordArtifact({
          handle,
          kind: "generated",
          locator: ArtifactLocator.cases.generated.make({ reference: "artifact-store:item-1" }),
        });
        expect(
          yield* Effect.flip(
            trace.recordArtifact({
              handle,
              kind: "file",
              locator: ArtifactLocator.cases.file.make({
                path: "../secret",
                sha256: "not-a-digest",
              }),
            }),
          ),
        ).toMatchObject({ reason: "unsafe_file_path" });
        yield* sqlRun("DELETE FROM subagents WHERE id = 'agent-1'");
        yield* sqlRun("DELETE FROM sessions WHERE id = 's1'");
        expect(yield* trace.taskDetail("s1", handle.taskId)).toBeNull();
        expect(yield* trace.projectTaskDetail("p1", handle.taskId)).toEqual(
          expect.objectContaining({ artifacts: [expect.any(Object)] }),
        );
        expect(yield* trace.projectTaskDetail("other", handle.taskId)).toBeNull();
      }),
    ),
  );
});

describe("Work Trace final answer sources", () => {
  it.effect("links a final answer to the used report and reflected notification once", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* start(trace);
        const notificationId = yield* trace.notifyParent({
          taskId: handle.taskId,
          kind: "completed",
          summary: "Subagent completed",
          idempotencyKey: "test:completed",
          deliveredImmediately: true,
        });
        expect(notificationId).not.toBeNull();
        const claim = {
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
          usedReports: [{ taskId: handle.taskId, attemptId: handle.id }],
          reflectedNotificationIds: [notificationId!],
        };
        const claimId = yield* trace.finalizeAnswerClaim(claim);
        expect(yield* trace.finalizeAnswerClaim(claim)).toBe(claimId);
        expect((yield* trace.taskDetail("s1", handle.taskId))!.answerClaims).toEqual([
          expect.objectContaining({
            id: claimId,
            parentMessageId: "parent-answer",
            notificationIds: [notificationId],
            sources: [{ taskId: handle.taskId, attemptId: handle.id }],
          }),
        ]);
      }),
    ),
  );

  it.effect("rejects a report outside the session and an undelivered notification", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* start(trace);
        const base = {
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
        };
        const rejections = [
          yield* Effect.flip(
            trace.finalizeAnswerClaim({
              ...base,
              usedReports: [{ taskId: handle.taskId, attemptId: "another-attempt" }],
              reflectedNotificationIds: [],
            }),
          ),
          yield* Effect.flip(
            trace.finalizeAnswerClaim({
              ...base,
              usedReports: [],
              reflectedNotificationIds: ["never-delivered"],
            }),
          ),
        ];
        expect(rejections).toEqual([expect.any(WorkTraceRejected), expect.any(WorkTraceRejected)]);
        expect(rejections).toMatchObject([
          { reason: "foreign_report" },
          { reason: "undelivered_notification" },
        ]);
      }),
    ),
  );
});
