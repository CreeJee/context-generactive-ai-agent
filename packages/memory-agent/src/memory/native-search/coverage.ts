// What a search has not covered yet, counted by the native search worker beside each read.
import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { embeddedKindFilter, meaningfulNodeFilter } from "../quality.ts";

const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Finite }));

export interface ReadCoverage {
  /** Statements `embedder` has not embedded yet, over every project. */
  readonly unindexed: number;
  /** Journaled node changes the lexical index has not applied yet, over every project. */
  readonly lexicalPending: number;
  /** Searchable nodes of the allowed projects whose interpretation is not done. */
  readonly uninterpreted: number;
}

/**
 * Counts on the worker's own read-only connection, after the native read. They are hints for the
 * model, so they need not come from the read's snapshot. Throws when the database cannot be read.
 */
export const readCoverage = (
  db: DatabaseSync,
  embedder: string,
  projects: readonly string[],
): ReadCoverage => {
  const count = (sql: string, ...params: readonly string[]) =>
    decodeCount(db.prepare(sql).get(...params)).count;
  return {
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
      projects.length === 0
        ? 0
        : count(
            `SELECT count(*) AS count FROM interpret_jobs j CROSS JOIN nodes n ON n.id = j.node_id
            WHERE j.status != 'done' AND ${meaningfulNodeFilter}
              AND n.project_id IN (${projects.map(() => "?").join(", ")})`,
            ...projects,
          ),
  };
};
