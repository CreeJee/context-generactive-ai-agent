// Minimal differential fixture for native read-session tests, not an application DB initializer.
import { DatabaseSync } from "node:sqlite";
import { Array as EffectArray } from "effect";
import { meaningfulNodeFilter } from "../quality.ts";
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
    CREATE VIRTUAL TABLE nodes_fts USING fts5(text, tokenize='trigram');
    CREATE VIRTUAL TABLE nodes_morph USING fts5(terms);
  `);
  const node = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?)");
  const text = db.prepare("INSERT INTO nodes_fts(rowid,text) VALUES (?, ?)");
  const morph = db.prepare("INSERT INTO nodes_morph(rowid,terms) VALUES (?, ?)");
  rows.forEach(([seq, id, kind, project, body]) => {
    node.run(seq, id, kind, project, body);
    text.run(seq, body);
    morph.run(seq, "로그 포맷 메모리");
  });
  db.exec(`
    INSERT INTO memory_graph_suppressed_nodes VALUES (4);
    INSERT INTO node_vectors VALUES (1,'fixture'),(2,'fixture'),(3,'fixture');
    INSERT INTO interpret_jobs VALUES ('alpha','queued'),('beta','done'),('other','queued'),('suppressed','queued'),('whitespace','queued'),('latest','queued');
  `);
  return db;
}

/** Worker integration uses the real owner migration path rather than relabeling a minimal DB. */
export function createApplicationReadFixture(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  migrateDatabase(db);
  db.exec(
    "INSERT INTO projects(id,root,name,created_at) VALUES ('allowed','/tmp/allowed','allowed','fixture'),('other-project','/tmp/other','other','fixture')",
  );
  db.exec(
    "INSERT INTO sessions(id,project_id,title,created_at) VALUES ('allowed-session','allowed',NULL,'fixture'),('other-project-session','other-project',NULL,'fixture')",
  );
  const node = db.prepare(
    "INSERT INTO nodes(seq,id,kind,project_id,text,session_id,created_at) VALUES (?,?,?,?,?,?,'fixture')",
  );
  const morph = db.prepare("INSERT INTO nodes_morph(rowid,terms) VALUES (?,'로그 포맷 메모리')");
  rows.forEach(([seq, id, kind, project, body]) => {
    node.run(seq, id, kind, project, body, `${project}-session`);
    morph.run(seq);
  });
  db.exec(`
    INSERT INTO memory_graph_suppressed_nodes VALUES (4,1,'fixture');
    INSERT INTO node_vectors VALUES (1,'fixture'),(2,'fixture'),(3,'fixture');
    INSERT OR REPLACE INTO interpret_jobs(node_id,status,updated_at) VALUES ('alpha','pending','fixture'),('beta','done','fixture'),('other','pending','fixture'),('suppressed','pending','fixture'),('whitespace','pending','fixture'),('latest','pending','fixture');
  `);
  return db;
}

/** Copies the inspected old SQL's project-before-limit and each-short-term append order. */
export function legacyFixtureChannels(db: DatabaseSync) {
  const terms = ["로그", "포맷"];
  const ranked = db
    .prepare(`SELECT n.id FROM nodes_fts f JOIN nodes n ON n.seq=f.rowid
    WHERE ${meaningfulNodeFilter} AND nodes_fts MATCH ? AND n.project_id IN (?) ORDER BY f.rank LIMIT ?`)
    .all('"sqlite"', "allowed", 2)
    .map((row) => String(row.id));
  const contained = terms.flatMap((term) =>
    db
      .prepare(`SELECT n.id FROM nodes n WHERE ${meaningfulNodeFilter}
      AND instr(n.text,?)>0 AND n.project_id IN (?) ORDER BY seq DESC LIMIT ?`)
      .all(term, "allowed", 2)
      .map((row) => String(row.id)),
  );
  const text = EffectArray.dedupe([...ranked, ...contained]);
  const morph = db
    .prepare(`SELECT n.id FROM nodes_morph f JOIN nodes n ON n.seq=f.rowid
    WHERE ${meaningfulNodeFilter} AND nodes_morph MATCH ? AND n.project_id IN (?) ORDER BY f.rank LIMIT ?`)
    .all('"로그" OR "포맷"', "allowed", 2)
    .map((row) => String(row.id));
  const unindexed = db
    .prepare(`SELECT count(*) AS count FROM nodes n LEFT JOIN node_vectors v ON v.node_seq=n.seq AND v.embedder=?
    WHERE v.node_seq IS NULL AND ${meaningfulNodeFilter} AND n.kind IN ('user','assistant','topic')`)
    .get("fixture")!;
  const uninterpreted = db
    .prepare(`SELECT count(*) AS count FROM interpret_jobs j JOIN nodes n ON n.id=j.node_id
    WHERE j.status!='done' AND ${meaningfulNodeFilter} AND n.project_id IN (?)`)
    .get("allowed")!;
  return {
    text,
    morph,
    unindexed: Number(unindexed.count),
    uninterpreted: Number(uninterpreted.count),
  };
}
