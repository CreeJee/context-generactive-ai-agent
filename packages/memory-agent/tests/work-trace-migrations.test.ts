import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";

const directories: string[] = [];
const databaseFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "work-trace-migration-"));
  directories.push(directory);
  return join(directory, "agent.db");
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const withDatabase = <A>(file: string, use: (db: Database["Type"]) => A) =>
  Effect.runPromise(
    Effect.scoped(Effect.map(Database, use)).pipe(Effect.provide(Database.layer(file))),
  );

function seedProjectSessionAndAgent(sqlite: DatabaseSync) {
  const iso = new Date(0).toISOString();
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
  test("upgrades an existing database additively without changing legacy subagents", async () => {
    const file = databaseFile();
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA foreign_keys = ON");
    for (const step of migrations.slice(0, -1)) legacy.exec(step);
    legacy.exec(`PRAGMA user_version = ${migrations.length - 1}`);
    seedProjectSessionAndAgent(legacy);
    legacy.close();

    const result = await withDatabase(file, (db) => ({
      version: db.sqlite.prepare("PRAGMA user_version").get(),
      agent: db.sqlite.prepare("SELECT id, last_task FROM subagents WHERE id = 'agent-1'").get(),
      tables: db.sqlite
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name IN
             ('work_tasks', 'agent_invocations', 'agent_run_attempts', 'run_events',
              'work_checkpoints', 'evidence_refs', 'work_artifacts', 'report_adoptions')
           ORDER BY name`,
        )
        .all(),
    }));

    expect(result.version).toEqual({ user_version: migrations.length });
    expect(result.agent).toEqual({ id: "agent-1", last_task: "legacy task" });
    expect(result.tables).toHaveLength(8);
  });

  test("enforces relationships, idempotency and one active attempt per task", async () => {
    await withDatabase(databaseFile(), (db) => {
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
            `INSERT INTO evidence_refs
             (id, task_id, attempt_id, source_kind, locator, verification, visibility,
              redaction, created_at, updated_at)
             VALUES ('evidence-cross-task', 'task-1', 'attempt-3', 'message',
                     '{"kind":"message","threadId":"subagent-agent-1","messageId":"m"}',
                     'verified', 'summary', 'clear', 3, 3)`,
          )
          .run(),
      ).toThrow();
    });
  });

  test("keeps project-owned trace and evidence when its origin session is deleted", async () => {
    await withDatabase(databaseFile(), (db) => {
      seedProjectSessionAndAgent(db.sqlite);
      seedTask(db.sqlite);
      db.sqlite
        .prepare(
          `INSERT INTO run_events
           (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
            visibility, redaction, summary, occurred_at)
           VALUES ('event-1', 's1', 'task-1', 'invocation-1', 'attempt-1', 1,
                   'activity', 'summary', 'clear', 'working', 1)`,
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO evidence_refs
           (id, task_id, attempt_id, source_kind, locator, verification, visibility,
            redaction, created_at, updated_at)
           VALUES ('evidence-1', 'task-1', 'attempt-1', 'tool_result',
                   '{"kind":"tool_result","threadId":"subagent-agent-1","toolCallId":"result-1"}',
                   'verified', 'summary', 'clear', 1, 1)`,
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
               (SELECT count(*) FROM evidence_refs WHERE task_id = 'task-1') AS evidence,
               (SELECT count(*) FROM work_artifacts WHERE task_id = 'task-1') AS artifacts`,
          )
          .get(),
      ).toEqual({ attempts: 1, evidence: 1, artifacts: 1 });
    });
  });

  test("backfills legacy evidence into typed locators and enforces source-deleted tombstones", async () => {
    const file = databaseFile();
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA foreign_keys = ON");
    // Stop before typed locators, answer provenance, knowledge promotion, and lifecycle receipts.
    // Reproduce the shipped schema, before the composite key was added to old CREATE TABLEs.
    const typedLocatorIndex = migrations.findIndex((step) =>
      step.includes("-- Evidence stores typed locators"),
    );
    expect(typedLocatorIndex).toBeGreaterThan(0);
    for (const step of migrations.slice(0, typedLocatorIndex))
      legacy.exec(step.replaceAll("    UNIQUE (id, task_id),\n", ""));
    legacy.exec(`PRAGMA user_version = ${typedLocatorIndex}`);
    seedProjectSessionAndAgent(legacy);
    seedTask(legacy);
    legacy
      .prepare(
        `INSERT INTO evidence_refs
         (id, task_id, attempt_id, source_kind, source_id, verification, visibility,
          redaction, created_at)
         VALUES ('legacy-evidence', 'task-1', 'attempt-1', 'message', 'message-1',
                 'verified', 'summary', 'clear', 1)`,
      )
      .run();
    legacy.close();

    await withDatabase(file, (db) => {
      expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.sqlite.prepare("SELECT count(*) AS count FROM agent_run_attempts").get()).toEqual({
        count: 1,
      });
      expect(
        db.sqlite
          .prepare(
            `SELECT source_kind, locator, verification, updated_at
             FROM evidence_refs WHERE id = 'legacy-evidence'`,
          )
          .get(),
      ).toEqual({
        source_kind: "message",
        locator: '{"kind":"message","threadId":"subagent-agent-1","messageId":"message-1"}',
        verification: "verified",
        updated_at: 1,
      });
      expect(() =>
        db.sqlite
          .prepare(
            `UPDATE evidence_refs
             SET verification = 'source_deleted', source_deleted_at = 2
             WHERE id = 'legacy-evidence'`,
          )
          .run(),
      ).toThrow();
      db.sqlite
        .prepare(
          `UPDATE evidence_refs
           SET verification = 'source_deleted', locator = NULL, source_deleted_at = 2, updated_at = 2
           WHERE id = 'legacy-evidence'`,
        )
        .run();
      expect(
        db.sqlite
          .prepare(
            "SELECT locator, verification, source_deleted_at FROM evidence_refs WHERE id = 'legacy-evidence'",
          )
          .get(),
      ).toEqual({ locator: null, verification: "source_deleted", source_deleted_at: 2 });
    });
  });

  test("assigns durable event cursors and rejects duplicate attempt sequence numbers", async () => {
    await withDatabase(databaseFile(), (db) => {
      seedProjectSessionAndAgent(db.sqlite);
      seedTask(db.sqlite);
      const insert = db.sqlite.prepare(
        `INSERT INTO run_events
         (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
          visibility, redaction, summary, occurred_at)
         VALUES (?, 's1', 'task-1', 'invocation-1', 'attempt-1', ?, 'activity',
                 'summary', 'clear', ?, ?)`,
      );
      insert.run("event-1", 1, "one", 1);
      insert.run("event-2", 2, "two", 2);
      expect(db.sqlite.prepare("SELECT seq, id FROM run_events ORDER BY seq").all()).toEqual([
        { seq: 1, id: "event-1" },
        { seq: 2, id: "event-2" },
      ]);
      expect(() => insert.run("event-duplicate", 2, "duplicate", 3)).toThrow();
    });
  });
});
