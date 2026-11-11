/**
 * Node lookups on the `SqlClient` in scope: the copy's database, opened read-only by the set's own
 * steps or by the app's services when a step searches.
 */
import { Array as Arr, Effect, HashMap, Iterable, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

export const NodeRecord = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  created_at: Schema.String,
});
export type NodeRecord = typeof NodeRecord.Type;

/** Ids per statement, well under SQLite's bound on statement parameters. */
const idsPerStatement = 500;
const chunks = (ids: ReadonlyArray<string>) => Iterable.chunksOf(Arr.dedupe(ids), idsPerStatement);

/** The seq of each id that names a node; seqs grow in the order nodes were stored. */
export const nodeSeqs = Effect.fn("searchSet.nodeSeqs")(function* (ids: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: Schema.Struct({ id: Schema.String, seq: Schema.Finite }),
    execute: (chunk) => sql`SELECT id, seq FROM nodes WHERE id IN ${sql.in(chunk)}`,
  });
  const rows = (yield* Effect.forEach(chunks(ids), select)).flat();
  return HashMap.fromIterable(Iterable.map(rows, ({ id, seq }) => [id, seq] as const));
});

/** The nodes the ids name, in the order of the ids; ids naming no node are left out. */
export const nodeRecords = Effect.fn("searchSet.nodeRecords")(function* (
  ids: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: NodeRecord,
    execute: (chunk) =>
      sql`SELECT id, kind, text, created_at FROM nodes WHERE id IN ${sql.in(chunk)}`,
  });
  const byId = HashMap.fromIterable(
    Iterable.map(
      (yield* Effect.forEach(chunks(ids), select)).flat(),
      (row) => [row.id, row] as const,
    ),
  );
  return Arr.getSomes(ids.map((id) => HashMap.get(byId, id)));
});

/** Statements per lookup, as the turn path and automatic recall read them. */
const recentUserStatements = 3;

/**
 * The last user statements before `beforeSeq` in the session of the node stored at that seq (a
 * recorded call, or the first node of a turn's run), oldest first; none when no node has that seq.
 */
export const statementsBefore = Effect.fn("searchSet.statementsBefore")(function* (
  beforeSeq: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Schema.Struct({ text: Schema.String }),
    execute: (seq) => sql`
      SELECT text FROM nodes WHERE kind = 'user' AND seq < ${seq}
        AND session_id = (SELECT session_id FROM nodes WHERE seq = ${seq})
      ORDER BY seq DESC LIMIT ${recentUserStatements}`,
  })(beforeSeq);
  return rows.map((row) => row.text).reverse();
});
