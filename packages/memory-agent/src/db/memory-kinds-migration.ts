import type { DatabaseSync } from "node:sqlite";
import { Option, Schema } from "effect";

/**
 * The step that adds the memory note kinds (docs/decisions.md, 2026-11-13 "진행 중인 run도
 * 줄이고, 진행 메모는 근거와 함께 남긴다"): node kind `note`, and edge kinds `cites` (a note to its
 * evidence) and `supersedes` (a later note to the one it replaces). SQLite cannot change a CHECK,
 * so startup runs {@link rebuildMemoryKinds} with this step to rebuild both tables.
 */
export const memoryNoteKindsMigration = `
  -- nodes and edges gain the note kinds; startup runs rebuildMemoryKinds with this step.
`;

/** The kind CHECK of each table as the schema has it, and what it becomes. */
const kindChecks = {
  nodes: {
    from: "CHECK (kind IN ('user', 'assistant', 'tool_call', 'tool_result', 'file_observation', 'topic'))",
    to: "CHECK (kind IN ('user', 'assistant', 'tool_call', 'tool_result', 'file_observation', 'topic', 'note'))",
  },
  edges: {
    from: "CHECK (kind IN ('next', 'reply', 'calls', 'returns', 'touches', 'about', 'corrects', 'retracts', 'related'))",
    to: "CHECK (kind IN ('next', 'reply', 'calls', 'returns', 'touches', 'about', 'corrects', 'retracts', 'related', 'cites', 'supersedes'))",
  },
} as const;

type RebuiltTable = keyof typeof kindChecks;

/** Why the rebuild stopped; the transaction rolls back with it. */
export type MemoryKindsRebuildFailure = "SchemaUnexpected" | "RowsChanged";

const decodeSql = Schema.decodeUnknownOption(Schema.Struct({ sql: Schema.String }));
const decodeCount = Schema.decodeUnknownOption(Schema.Struct({ count: Schema.Finite }));
const decodeSeq = Schema.decodeUnknownOption(Schema.Struct({ seq: Schema.Finite }));

const tableSql = (sqlite: DatabaseSync, table: RebuiltTable) =>
  Option.map(
    decodeSql(
      sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    ),
    (row) => row.sql,
  );

/** How many rows `query` gives; none when SQLite answered something else. */
const count = (sqlite: DatabaseSync, query: string) =>
  Option.map(
    decodeCount(sqlite.prepare(`SELECT count(*) AS count FROM (${query})`).get()),
    (row) => row.count,
  );

/**
 * Rebuilds one table under its new kind CHECK, keeping its columns, rows in rowid order, indexes
 * and triggers as the schema has them now. Rows are compared both ways before the old table goes,
 * so a copy that lost or changed a row stops the migration.
 */
const rebuild = (
  sqlite: DatabaseSync,
  table: RebuiltTable,
): MemoryKindsRebuildFailure | undefined => {
  const create = `CREATE TABLE ${table} (`;
  const check = kindChecks[table];
  const found = Option.filter(
    tableSql(sqlite, table),
    (sql) => sql.startsWith(create) && sql.split(check.from).length === 2,
  );
  if (Option.isNone(found)) return "SchemaUnexpected";
  const sql = found.value;
  const copy = `${table}_with_note_kinds`;
  const attached = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid",
    )
    .all(table)
    .flatMap((row) => Option.toArray(Option.map(decodeSql(row), (decoded) => decoded.sql)));
  sqlite.exec(sql.replace(create, `CREATE TABLE ${copy} (`).replace(check.from, check.to));
  sqlite.exec(`INSERT INTO ${copy} SELECT * FROM ${table} ORDER BY rowid`);
  const kept = Option.all([
    count(sqlite, `SELECT * FROM ${table} EXCEPT SELECT * FROM ${copy}`),
    count(sqlite, `SELECT * FROM ${copy} EXCEPT SELECT * FROM ${table}`),
    count(sqlite, `SELECT 1 FROM ${table}`),
    count(sqlite, `SELECT 1 FROM ${copy}`),
  ]).pipe(
    Option.exists(([lost, added, before, after]) => lost === 0 && added === 0 && before === after),
  );
  if (!kept) return "RowsChanged";
  sqlite.exec(`DROP TABLE ${table}`);
  sqlite.exec(`ALTER TABLE ${copy} RENAME TO ${table}`);
  attached.forEach((statement) => sqlite.exec(statement));
  return undefined;
};

/**
 * Rebuilds `nodes` and `edges` with the note kinds. Runs inside the startup migration, with foreign
 * keys off. `nodes` keeps its AUTOINCREMENT high-water mark, so a deleted node's seq is never
 * handed out again.
 */
export const rebuildMemoryKinds = (sqlite: DatabaseSync): MemoryKindsRebuildFailure | undefined => {
  const issued = Option.map(
    decodeSeq(sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'nodes'").get()),
    (row) => row.seq,
  );
  const failure = rebuild(sqlite, "nodes") ?? rebuild(sqlite, "edges");
  if (failure === undefined && Option.isSome(issued)) {
    sqlite
      .prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'nodes'")
      .run(issued.value);
    sqlite
      .prepare(
        "INSERT INTO sqlite_sequence (name, seq) SELECT 'nodes', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'nodes')",
      )
      .run(issued.value);
  }
  return failure;
};
