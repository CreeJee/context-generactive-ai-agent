// Minimal differential fixture for native read-session tests, not an application DB initializer.
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { migrateDatabase } from "../../db/database.ts";

const rows = [
  [1, "alpha", "user", "allowed", "sqlite 로그 포맷"],
  [2, "beta", "assistant", "allowed", "로그 포맷 변경"],
  [3, "other", "user", "other-project", "sqlite 로그 포맷"],
  [4, "suppressed", "topic", "allowed", "sqlite 로그 포맷"],
  [5, "whitespace", "user", "allowed", "\u00a0\u2028"],
  [6, "latest", "topic", "allowed", "로그 메모리"],
  [7, "global-unindexed", "assistant", "other-project", "검색 기록"],
] as const;

export function createReadFixture(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE nodes(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, kind TEXT, project_id TEXT, text TEXT);
    CREATE TABLE node_vectors(node_seq INTEGER, embedder TEXT);
    CREATE TABLE node_vector_chunks(vector_id INTEGER PRIMARY KEY, node_seq INTEGER, embedder TEXT, start_offset INTEGER, end_offset INTEGER);
    CREATE TABLE memory_graph_suppressed_nodes(node_seq INTEGER);
    CREATE TABLE interpret_jobs(node_id TEXT, status TEXT);
    CREATE TABLE lexical_changes(id INTEGER PRIMARY KEY, node_seq INTEGER);
  `);
  const node = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?)");
  rows.forEach(([seq, id, kind, project, body]) => node.run(seq, id, kind, project, body));
  db.exec(`
    INSERT INTO memory_graph_suppressed_nodes VALUES (4);
    INSERT INTO node_vectors VALUES (1,'fixture'),(2,'fixture'),(3,'fixture');
    INSERT INTO interpret_jobs VALUES ('alpha','queued'),('beta','done'),('other','queued'),('suppressed','queued'),('whitespace','queued'),('latest','queued');
  `);
  return db;
}

/** Worker integration uses the real owner migration path rather than relabeling a minimal DB. */
export const createApplicationReadFixture = Effect.fnUntraced(function* (path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  yield* migrateDatabase(db);
  db.exec(
    "INSERT INTO projects(id,root,name,created_at) VALUES ('allowed','/tmp/allowed','allowed','fixture'),('other-project','/tmp/other','other','fixture')",
  );
  db.exec(
    "INSERT INTO sessions(id,project_id,title,created_at) VALUES ('allowed-session','allowed',NULL,'fixture'),('other-project-session','other-project',NULL,'fixture')",
  );
  const node = db.prepare(
    "INSERT INTO nodes(seq,id,kind,project_id,text,session_id,created_at) VALUES (?,?,?,?,?,?,'fixture')",
  );
  rows.forEach(([seq, id, kind, project, body]) =>
    node.run(seq, id, kind, project, body, `${project}-session`),
  );
  // The lexical index is given every row as it is now (`lexicalDocuments`): nothing is pending.
  db.exec(`
    INSERT INTO memory_graph_suppressed_nodes VALUES (4,1,'fixture');
    INSERT INTO node_vectors VALUES (1,'fixture'),(2,'fixture'),(3,'fixture');
    INSERT OR REPLACE INTO interpret_jobs(node_id,status,updated_at) VALUES ('alpha','pending','fixture'),('beta','done','fixture'),('other','pending','fixture'),('suppressed','pending','fixture'),('whitespace','pending','fixture'),('latest','pending','fixture');
    DELETE FROM lexical_changes;
  `);
  return db;
});

/** The fixture rows the indexer gives the lexical index: not the suppressed one or the blank one. */
export const lexicalDocuments = rows
  .filter(([, id]) => id !== "suppressed" && id !== "whitespace")
  .map(([seq, , , project, text]) => ({ seq, project, text }));
