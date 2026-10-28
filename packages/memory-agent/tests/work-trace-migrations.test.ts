import { it } from "@effect/vitest";
import { Layer } from "effect";

import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import {
  ArtifactLocator,
  AttemptFailure,
  AttemptFailureReason,
} from "../src/work-trace/contracts.ts";

const databaseFile = Effect.fn("workTrace.databaseFile")(function* () {
  const context = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "work-trace-migration-" }),
      "agent.db",
    );
  }).pipe(Effect.provideContext(context));
});

/** The schema boundary itself: a raw connection the startup migration has brought up to date. */
const withDatabase = Effect.fnUntraced(function* <A>(
  file: string,
  use: (db: { readonly sqlite: DatabaseSync }) => A,
) {
  const sqlite = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const sqlite = new DatabaseSync(file);
      sqlite.exec("PRAGMA foreign_keys = ON");
      return sqlite;
    }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );
  yield* migrateDatabase(sqlite);
  return use({ sqlite });
}, Effect.scoped);

function seedProjectSessionAndAgent(sqlite: DatabaseSync) {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(0));
  sqlite
    .prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)")
    .run(iso);
  sqlite
    .prepare(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    )
    .run(iso);
  sqlite
    .prepare(
      `INSERT INTO subagents
       (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
       VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'legacy task', 1, 1)`,
    )
    .run();
}

function seedTask(sqlite: DatabaseSync) {
  sqlite
    .prepare(
      `INSERT INTO work_tasks
       (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_id,
        agent_name, status, title, request, active_attempt_id, created_at, updated_at)
       VALUES ('task-1', 'p1', 's1', 'parent-1', 'call-1', 'agent-1', 'researcher',
               'running', 'Research', 'Inspect the code', NULL, 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_invocations
       (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
        target_attempt_id, idempotency_key, created_at)
       VALUES ('invocation-1', 'task-1', 'parent-1', 'call-1', 'start', 'running',
               'Inspect the code', NULL, 'start:call-1', 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_run_attempts
       (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
        created_at, updated_at)
       VALUES ('attempt-1', 'task-1', 'invocation-1', 1, 'child-run-1',
               'subagent-agent-1', 'running', 1, 1)`,
    )
    .run();
}

describe("Work Trace migration", () => {
  it.live("upgrades an existing database additively without changing legacy subagents", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile();
      const legacy = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(file)),
        (db) =>
          Effect.sync(() => {
            if (db.isOpen) db.close();
          }),
      );
      legacy.exec("PRAGMA foreign_keys = ON");
      migrations.slice(0, -1).forEach((step) => legacy.exec(step));
      legacy.exec(`PRAGMA user_version = ${migrations.length - 1}`);
      seedProjectSessionAndAgent(legacy);
      legacy.close();

      const result = yield* withDatabase(file, (db) => ({
        version: db.sqlite.prepare("PRAGMA user_version").get(),
        agent: db.sqlite.prepare("SELECT id, last_task FROM subagents WHERE id = 'agent-1'").get(),
        tables: db.sqlite
          .prepare(
            `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name IN
             ('work_tasks', 'agent_invocations', 'agent_run_attempts', 'run_events',
              'work_artifacts')
           ORDER BY name`,
          )
          .all(),
      }));

      expect(result.version).toEqual({ user_version: migrations.length });
      expect(result.agent).toEqual({ id: "agent-1", last_task: "legacy task" });
      expect(result.tables).toHaveLength(5);
    }),
  );

  it.live("enforces relationships, idempotency and one active attempt per task", () =>
    Effect.flatMap(databaseFile(), (file) =>
      withDatabase(file, (db) => {
        seedProjectSessionAndAgent(db.sqlite);
        seedTask(db.sqlite);

        expect(() =>
          db.sqlite
            .prepare(
              `INSERT INTO agent_invocations
             (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
              idempotency_key, created_at)
             VALUES ('invocation-duplicate', 'task-1', 'parent-1', 'call-1', 'start',
                     'accepted', 'duplicate', 'start:call-1', 2)`,
            )
            .run(),
        ).toThrow();

        db.sqlite
          .prepare(
            `INSERT INTO agent_invocations
           (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
            idempotency_key, created_at)
           VALUES ('invocation-2', 'task-1', 'parent-1', 'call-2', 'resume',
                   'accepted', 'resume', 'resume:call-2', 2)`,
          )
          .run();
        expect(() =>
          db.sqlite
            .prepare(
              `INSERT INTO agent_run_attempts
             (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
              resumed_from_attempt_id, created_at, updated_at)
             VALUES ('attempt-2', 'task-1', 'invocation-2', 2, 'child-run-2',
                     'subagent-agent-1', 'queued', 'attempt-1', 2, 2)`,
            )
            .run(),
        ).toThrow();

        db.sqlite
          .prepare("UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = 'attempt-1'")
          .run();
        db.sqlite
          .prepare(
            `INSERT INTO agent_run_attempts
           (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
            resumed_from_attempt_id, created_at, updated_at)
           VALUES ('attempt-2', 'task-1', 'invocation-2', 2, 'child-run-2',
                   'subagent-agent-1', 'queued', 'attempt-1', 2, 2)`,
          )
          .run();
        expect(
          db.sqlite
            .prepare(
              "SELECT id, resumed_from_attempt_id FROM agent_run_attempts ORDER BY attempt_number",
            )
            .all(),
        ).toEqual([
          { id: "attempt-1", resumed_from_attempt_id: null },
          { id: "attempt-2", resumed_from_attempt_id: "attempt-1" },
        ]);

        expect(() =>
          db.sqlite
            .prepare(
              `INSERT INTO run_events
             (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
              visibility, redaction, summary, occurred_at)
             VALUES ('event-bad', 's1', 'missing', 'invocation-2', 'attempt-2', 1,
                     'attempt_started', 'public', 'clear', 'bad', 2)`,
            )
            .run(),
        ).toThrow();

        db.sqlite
          .prepare(
            `INSERT INTO work_tasks
           (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_id,
            agent_name, status, title, request, active_attempt_id, created_at, updated_at)
           VALUES ('task-2', 'p1', 's1', 'parent-1', 'call-3', 'agent-1', 'researcher',
                   'running', 'Other', 'Other task', NULL, 3, 3)`,
          )
          .run();
        db.sqlite
          .prepare(
            `INSERT INTO agent_invocations
           (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
            idempotency_key, created_at)
           VALUES ('invocation-3', 'task-2', 'parent-1', 'call-3', 'start', 'running',
                   'Other task', 'start:call-3', 3)`,
          )
          .run();
        db.sqlite
          .prepare(
            `INSERT INTO agent_run_attempts
           (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
            created_at, updated_at)
           VALUES ('attempt-3', 'task-2', 'invocation-3', 1, 'child-run-3',
                   'subagent-agent-1', 'running', 3, 3)`,
          )
          .run();
        expect(() =>
          db.sqlite
            .prepare(
              `INSERT INTO work_artifacts
             (id, task_id, attempt_id, kind, locator, verification, created_at, updated_at)
             VALUES ('artifact-cross-task', 'task-1', 'attempt-3', 'generated',
                     '{"kind":"generated","reference":"r"}', 'verified', 3, 3)`,
            )
            .run(),
        ).toThrow();
      }),
    ),
  );

  it.live("rewrites artifact locators 0.0.17 stored under kind as the store encodes them", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile();
      const locatorMigration = migrations.findIndex((step) =>
        step.includes("artifact locator names its case under _tag"),
      );
      expect(locatorMigration).toBeGreaterThanOrEqual(0);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new DatabaseSync(file)),
        (legacy) =>
          Effect.sync(() => {
            legacy.exec("PRAGMA foreign_keys = ON");
            migrations.slice(0, locatorMigration).forEach((step) => legacy.exec(step));
            legacy.exec(`PRAGMA user_version = ${locatorMigration}`);
            seedProjectSessionAndAgent(legacy);
            seedTask(legacy);
            // Locators as 0.0.17 wrote them, with the case under kind.
            const insert = legacy.prepare(`INSERT INTO work_artifacts
              (id, task_id, attempt_id, kind, locator, verification, created_at, updated_at)
              VALUES (?, 'task-1', 'attempt-1', ?, ?, 'verified', 1, 1)`);
            insert.run(
              "artifact-file",
              "file",
              `{"kind":"file","path":"보고서/report.md","sha256":"${"a".repeat(64)}"}`,
            );
            insert.run("artifact-generated", "generated", '{"kind":"generated","reference":"g-1"}');
            insert.run("artifact-external", "external", '{"kind":"external","reference":"x-1"}');
          }),
        (legacy) => Effect.sync(() => legacy.close()),
      );

      const rows = yield* withDatabase(file, (db) =>
        db.sqlite.prepare("SELECT id, locator FROM work_artifacts ORDER BY id").all(),
      );
      const encode = Schema.encodeEffect(Schema.fromJsonString(ArtifactLocator));
      expect(rows).toEqual([
        {
          id: "artifact-external",
          locator: yield* encode(ArtifactLocator.cases.external.make({ reference: "x-1" })),
        },
        {
          id: "artifact-file",
          locator: yield* encode(
            ArtifactLocator.cases.file.make({ path: "보고서/report.md", sha256: "a".repeat(64) }),
          ),
        },
        {
          id: "artifact-generated",
          locator: yield* encode(ArtifactLocator.cases.generated.make({ reference: "g-1" })),
        },
      ]);
    }),
  );

  it.live("keeps project-owned trace when its origin session is deleted", () =>
    Effect.flatMap(databaseFile(), (file) =>
      withDatabase(file, (db) => {
        seedProjectSessionAndAgent(db.sqlite);
        seedTask(db.sqlite);
        db.sqlite
          .prepare(
            `INSERT INTO run_events
           (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
            visibility, redaction, summary, occurred_at)
           VALUES ('event-1', 's1', 'task-1', 'invocation-1', 'attempt-1', 1,
                   'attempt_started', 'summary', 'clear', 'working', 1)`,
          )
          .run();
        db.sqlite
          .prepare(
            `INSERT INTO work_artifacts
           (id, task_id, attempt_id, kind, locator, media_type, verification,
            created_at, updated_at)
           VALUES ('artifact-1', 'task-1', 'attempt-1', 'file',
                   '{"kind":"file","path":"report.md","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
                   'text/markdown', 'verified', 1, 1)`,
          )
          .run();
        // The parent-delete workflow removes session-owned identities first. Work Trace must survive
        // both identity deletion and the following origin-session deletion.
        db.sqlite.prepare("DELETE FROM subagents WHERE id = 'agent-1'").run();
        db.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run();

        expect(
          db.sqlite
            .prepare(
              `SELECT project_id, origin_session_id, agent_id, agent_name
             FROM work_tasks WHERE id = 'task-1'`,
            )
            .get(),
        ).toEqual({
          project_id: "p1",
          origin_session_id: null,
          agent_id: null,
          agent_name: "researcher",
        });
        expect(
          db.sqlite.prepare("SELECT origin_session_id FROM run_events WHERE id = 'event-1'").get(),
        ).toEqual({ origin_session_id: null });
        expect(
          db.sqlite
            .prepare(
              `SELECT
               (SELECT count(*) FROM agent_run_attempts WHERE task_id = 'task-1') AS attempts,
               (SELECT count(*) FROM work_artifacts WHERE task_id = 'task-1') AS artifacts`,
            )
            .get(),
        ).toEqual({ attempts: 1, artifacts: 1 });
      }),
    ),
  );

  it.live("keeps progress, failure and requested retries when dropping trace history", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile();
      const legacy = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(file)),
        (db) =>
          Effect.sync(() => {
            if (db.isOpen) db.close();
          }),
      );
      legacy.exec("PRAGMA foreign_keys = ON");
      // The 0.0.17 schema: every step before the one that drops trace history.
      const dropTraceHistory = migrations.findIndex((step) =>
        step.includes("DROP TABLE IF EXISTS evidence_refs_v3"),
      );
      migrations.slice(0, dropTraceHistory).forEach((step) => legacy.exec(step));
      legacy.exec(`PRAGMA user_version = ${dropTraceHistory}`);
      seedProjectSessionAndAgent(legacy);
      seedTask(legacy);
      legacy
        .prepare(
          `UPDATE agent_run_attempts
           SET status = 'interrupted', resume_reason = 'server_restarted', finished_at = 2
           WHERE id = 'attempt-1'`,
        )
        .run();
      const event = legacy.prepare(
        `INSERT INTO run_events
         (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
          visibility, redaction, summary, payload, occurred_at)
         VALUES (?, 's1', 'task-1', 'invocation-1', 'attempt-1', ?, ?, 'summary', 'clear', ?, ?, ?)`,
      );
      event.run("event-1", 1, "attempt_started", "Started", "{}", 1);
      event.run("event-2", 2, "tool_requested", "Requested", '{"toolCallId":"tool-a"}', 1);
      event.run("event-3", 3, "tool_requested", "Requested", '{"toolCallId":"tool-b"}', 1);
      event.run("event-4", 4, "tool_completed", "Completed", '{"toolCallId":"tool-b"}', 1);
      legacy
        .prepare(
          `INSERT INTO evidence_refs
           (id, task_id, attempt_id, source_kind, locator, verification, visibility,
            redaction, created_at, updated_at)
           VALUES ('evidence-1', 'task-1', 'attempt-1', 'message',
                   '{"kind":"message","threadId":"subagent-agent-1","messageId":"m"}',
                   'verified', 'summary', 'clear', 1, 1)`,
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO work_recovery_jobs
           (id, project_id, task_id, interrupted_attempt_id, status, created_at, updated_at,
            confirm_uncertain)
           VALUES ('job-1', 'p1', 'task-1', 'attempt-1', 'queued', 5, 5, 1)`,
        )
        .run();
      legacy.close();
      const restarted = yield* Schema.encodeEffect(Schema.fromJsonString(AttemptFailure))({
        reason: AttemptFailureReason.cases.ServerRestarted.make({}),
        stage: "restart",
      });

      yield* withDatabase(file, (db) => {
        expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          db.sqlite
            .prepare(
              `SELECT pending_tool_call_ids, failure, heartbeat_state
               FROM agent_run_attempts WHERE id = 'attempt-1'`,
            )
            .get(),
        ).toEqual({
          pending_tool_call_ids: '["tool-a"]',
          failure: restarted,
          heartbeat_state: "idle",
        });
        expect(
          db.sqlite
            .prepare(
              "SELECT retry_requested_at, retry_confirm_uncertain FROM work_tasks WHERE id = 'task-1'",
            )
            .get(),
        ).toEqual({ retry_requested_at: 5, retry_confirm_uncertain: 1 });
        expect(db.sqlite.prepare("SELECT id FROM run_events").all()).toEqual([{ id: "event-1" }]);
        expect(
          db.sqlite
            .prepare(
              `SELECT name FROM sqlite_schema WHERE type = 'table' AND (
                 name LIKE 'evidence_refs%' OR name LIKE 'report_adoptions%'
                 OR name LIKE 'work_checkpoints%' OR name LIKE 'work_recovery_jobs%')`,
            )
            .all(),
        ).toEqual([]);
      });
    }),
  );

  it.live("assigns durable event cursors and rejects duplicate attempt sequence numbers", () =>
    Effect.flatMap(databaseFile(), (file) =>
      withDatabase(file, (db) => {
        seedProjectSessionAndAgent(db.sqlite);
        seedTask(db.sqlite);
        const insert = db.sqlite.prepare(
          `INSERT INTO run_events
         (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
          visibility, redaction, summary, occurred_at)
         VALUES (?, 's1', 'task-1', 'invocation-1', 'attempt-1', ?, 'steered',
                 'summary', 'clear', ?, ?)`,
        );
        insert.run("event-1", 1, "one", 1);
        insert.run("event-2", 2, "two", 2);
        expect(db.sqlite.prepare("SELECT seq, id FROM run_events ORDER BY seq").all()).toEqual([
          { seq: 1, id: "event-1" },
          { seq: 2, id: "event-2" },
        ]);
        expect(() => insert.run("event-duplicate", 2, "duplicate", 3)).toThrow();
      }),
    ),
  );
});
