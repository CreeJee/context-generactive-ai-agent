import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, ownerRpcLedgerMigration } from "../src/db/migrations.ts";

/** A fingerprint as released versions wrote it, around `input` in the owner's frame. */
const fingerprint = (operation: string, input: string) =>
  `json_object('_tag', 'OwnerRpcFingerprintV1', 'algorithm', 'sha256',
    'canonicalization', 'owner-rpc-json-v1', 'digest', '${"0".repeat(64)}',
    'operation', '${operation}', 'input', json('${input}'), 'inputKind', 'complete')`;
const call = (name: string, toolCallId: string) =>
  fingerprint(
    "tool",
    `["object",[["name",["string","${name}"]],["args",["object",[]]],["toolCallId",["string","${toolCallId}"]]]]`,
  );
const reply = (tag: string, operationId: number, output = "") =>
  `json_object('_tag', '${tag}', 'operationId', ${operationId}${output === "" ? "" : `, 'output', json('${output}')`})`;

it.effect("an owner operation keeps its kind, tool and ending as columns", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(ownerRpcLedgerMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO workflow_goal_identities VALUES ('s', 'g', 'old');
      INSERT INTO workflow_state_revisions
        (id, session_id, goal_version, plan_version, provenance, created_at, goal_instance_id)
        VALUES (1, 's', 1, NULL, 'recorded', 'old', 'g');
      INSERT INTO workflow_run_bindings VALUES
        ('run', 's', 'g', 1, NULL, 1, 'old'),
        ('recovered', 's', 'g', 1, NULL, 1, 'old'),
        ('stale', 's', 'g', 1, NULL, 1, 'old');
      INSERT INTO owner_rpc_operations VALUES
        ('run', 'key', 1, ${call("run_shell", "call-1")}, 1, ${reply("succeeded", 1, '"returned"')}, 'succeeded'),
        ('run', 'key', 2, ${call("read_file", "call-2")}, 1, ${reply("succeeded", 2, '"failed"')}, 'succeeded'),
        ('run', 'key', 3, ${call("write_file", "call-3")}, 1, ${reply("uncertain", 3)}, 'uncertain'),
        ('run', 'key', 4, ${call("write_file", "call-4")}, 1, ${reply("pending", 4)}, 'pending'),
        ('run', 'key', 5, ${fingerprint("middleware", '["object",[["index",["number",0]],["hook",["string","h"]]]]')},
          1, ${reply("succeeded", 5, '["object",[]]')}, 'succeeded'),
        ('run', 'key', 6, ${fingerprint("modelNext", '["object",[["id",["string","m"]]]]')},
          0, ${reply("succeeded", 6, '["object",[]]')}, 'succeeded'),
        ('run', 'key', 7, ${fingerprint("tool", '["string","abc"]')}, 1, ${reply("succeeded", 7, '"returned"')}, 'succeeded'),
        ('run', 'key', 8, 'not json', 1, ${reply("succeeded", 8, '"refused"')}, 'succeeded'),
        ('recovered', 'key', 1, ${fingerprint("toolAuthorize", '["object",[["name",["string","read_file"]],["toolCallId",["string","read"]]]]')},
          1, ${reply("succeeded", 1, '["object",[]]')}, 'succeeded'),
        ('recovered', 'key', 2, ${call("read_file", "read")}, 1, ${reply("uncertain", 2)}, 'uncertain'),
        ('stale', 'key', 1, 'authorization', 1, ${reply("succeeded", 1, '["object",[]]')}, 'succeeded'),
        ('stale', 'key', 2, 'operation', 1, ${reply("uncertain", 2)}, 'uncertain');
      INSERT INTO owner_workflow_executions (execution_id, workflow_name, payload_json, status, result_json)
        VALUES ('execution', 'GoalExecution', '{}', 'completed', '{}');
      -- A receipt matches its operations' fingerprints and run key; the stale one names other ones.
      INSERT INTO owner_read_recoveries
        SELECT run_id || '-receipt', run_id, 's', 'g', 1, 2,
          CASE run_id WHEN 'stale' THEN 'other' ELSE
            (SELECT fingerprint FROM owner_rpc_operations o WHERE o.run_id = b.run_id AND o.operation_id = 2) END,
          (SELECT fingerprint FROM owner_rpc_operations o WHERE o.run_id = b.run_id AND o.operation_id = 1),
          'key', 1, 'execution', '{}', '{}', '${"a".repeat(64)}', 'background-result-read-v1',
          'confirm_read_only_and_continue_without_replay', 'backup', 1
        FROM workflow_run_bindings b WHERE run_id IN ('recovered', 'stale');
    `);

    yield* migrateDatabase(db);

    const row = (
      runId: string,
      operationId: number,
      operation: string | null,
      tool: readonly [string, string] | null,
      sideEffect: number,
      status: string,
      outcome: string | null,
    ) => ({
      run_id: runId,
      operation_id: operationId,
      operation,
      tool_name: tool?.[0] ?? null,
      tool_call_id: tool?.[1] ?? null,
      side_effect: sideEffect,
      status,
      outcome,
    });
    expect(
      db.prepare("SELECT * FROM owner_rpc_operations ORDER BY run_id, operation_id").all(),
    ).toEqual([
      row("recovered", 1, "toolAuthorize", ["read_file", "read"], 1, "succeeded", null),
      row("recovered", 2, "tool", ["read_file", "read"], 1, "uncertain", null),
      row("run", 1, "tool", ["run_shell", "call-1"], 1, "succeeded", "returned"),
      row("run", 2, "tool", ["read_file", "call-2"], 1, "succeeded", "failed"),
      row("run", 3, "tool", ["write_file", "call-3"], 1, "uncertain", null),
      row("run", 4, "tool", ["write_file", "call-4"], 1, "pending", null),
      row("run", 5, "middleware", null, 1, "succeeded", null),
      row("run", 6, "modelNext", null, 0, "succeeded", null),
      // An input that is not an object names no tool, and a fingerprint that is not JSON nothing.
      row("run", 7, "tool", null, 1, "succeeded", "returned"),
      row("run", 8, null, null, 1, "succeeded", "refused"),
      row("stale", 1, null, null, 1, "succeeded", null),
      row("stale", 2, null, null, 1, "uncertain", null),
    ]);
    expect(db.prepare("SELECT receipt_id FROM owner_read_recovery_revocations").all()).toEqual([
      { receipt_id: "stale-receipt" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
