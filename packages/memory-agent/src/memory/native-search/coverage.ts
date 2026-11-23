// What a search has not covered yet, counted by the native search worker apart from its reads.
import type { DatabaseSync } from "node:sqlite";
import { type Cause, Effect, Schema } from "effect";
import { embeddedKindFilter, meaningfulNodeFilter } from "../quality.ts";
import type { NativeCoverage, NativeCoverageInput } from "./read-protocol.ts";

const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Finite }));

/**
 * Counts on the worker's own read-only connection. They are hints for the model, so they need not
 * come from a read's snapshot. Fails when the database cannot be read.
 */
export const readCoverage = Effect.fn("readCoverage")(function* (
  db: DatabaseSync,
  { embedder, allowedProjects }: NativeCoverageInput,
): Effect.fn.Return<NativeCoverage, Cause.UnknownError | Schema.SchemaError> {
  const count = (sql: string, ...params: readonly string[]) =>
    Effect.try(() => db.prepare(sql).get(...params)).pipe(
      Effect.flatMap(decodeCount),
      Effect.map((row) => row.count),
    );
  return yield* Effect.all({
    // The filters spell the `nodes_embeddable` partial index's terms, so SQLite counts from it.
    unindexed: count(
      `SELECT count(*) AS count FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
      WHERE v.node_seq IS NULL AND ${meaningfulNodeFilter} AND ${embeddedKindFilter}`,
      embedder,
    ),
    lexicalPending: count("SELECT count(*) AS count FROM lexical_changes"),
    // CROSS JOIN keeps the few open jobs as the outer loop; otherwise SQLite walks every node of
    // the projects.
    uninterpreted:
      allowedProjects.length === 0
        ? Effect.succeed(0)
        : count(
            `SELECT count(*) AS count FROM interpret_jobs j CROSS JOIN nodes n ON n.id = j.node_id
            WHERE j.status != 'done' AND ${meaningfulNodeFilter}
              AND n.project_id IN (${allowedProjects.map(() => "?").join(", ")})`,
            ...allowedProjects,
          ),
  });
});
