import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";

it.effect("every change of what the lexical index holds for a node is journaled", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    yield* migrateDatabase(db);
    const journal = () =>
      db
        .prepare("SELECT node_seq FROM lexical_changes ORDER BY id")
        .all()
        .map((row) => row.node_seq);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES
        ('p', '/p', 'p', 'old'), ('q', '/q', 'q', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO nodes (id, project_id, session_id, kind, text, created_at) VALUES
        ('a', 'p', 's', 'user', 'first', 'old'), ('b', 'p', 's', 'user', 'second', 'old');
    `);
    expect(journal()).toEqual([1, 2]);
    db.exec("DELETE FROM lexical_changes");

    // A secret sweep's new text, a project move, suppression both ways, and a purge.
    db.exec(`
      INSERT INTO secret_sweep_permits (node_seq) VALUES (1);
      UPDATE nodes SET text = '[hidden]' WHERE seq = 1;
      DELETE FROM secret_sweep_permits;
      INSERT INTO node_project_moves (from_project, to_project) VALUES ('p', 'q');
      UPDATE nodes SET project_id = 'q' WHERE seq = 2;
      DELETE FROM node_project_moves;
      INSERT INTO memory_graph_suppressed_nodes (node_seq, version, reason) VALUES (2, 1, 'test');
      DELETE FROM memory_graph_suppressed_nodes;
      DELETE FROM nodes WHERE seq = 1;
    `);
    expect(journal()).toEqual([1, 2, 2, 2, 1]);
  }),
);
