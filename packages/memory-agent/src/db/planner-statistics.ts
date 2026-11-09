import { Effect, HashSet, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/**
 * Keeps the query planner's statistics (`sqlite_stat1`) current, as SQLite advises for a
 * long-lived connection: every table when the app starts, then the tables queried since every
 * hour (docs/decisions.md "쿼리 플래너 통계를 둔다 (2026-11-09)"). Without statistics the planner
 * guessed: a search's lookups for each match walked every later node of the match's project by
 * `nodes_project` instead of starting from the match, 65 ms to 2 s each.
 */

/**
 * Index rows one analysis reads per index. SQLite advises 100 to 1000. On a 6 GB copy with a warm
 * cache every table took 93 ms with this limit and 405 ms without one.
 */
const analysisLimit = 1000;
const checkEvery = "1 hour";

/**
 * Tables emptied by design: change journals a batch drains, the permits a statement holds only
 * inside its transaction, queues, and run logs pruned after their time. A count taken while one
 * is nearly empty says nothing about it minutes later, when an import or a long answer has filled
 * it, and a plan chosen for a few rows then reads all of them each time: a full scan where a rowid
 * range would do, every run's log for one run's page. They get no statistics, so the planner
 * assumes a large table for them, as it did when no table had statistics.
 */
const drainedTables = HashSet.make(
  "lexical_changes",
  "secret_sweep_changes",
  "memory_chunk_vector_removals",
  "memory_graph_vector_removals",
  "secret_sweep_permits",
  "node_project_moves",
  "persisted_queue_items",
  "queued_messages",
  "workflow_run_log_entries",
);

/** Which tables a refresh looks at: all of them, or those this connection has queried. */
type Scope = "all" | "used";

const Planned = Schema.Struct({ optimize: Schema.String });

/** The table an `ANALYZE "main"."<table>"` that `PRAGMA optimize` plans names. */
const analyzedTable = (statement: string) =>
  Option.map(Option.fromNullishOr(/^ANALYZE "main"\."(.+)"$/.exec(statement)?.[1]), (quoted) =>
    quoted.replaceAll('""', '"'),
  );

/**
 * Analyzes the tables whose statistics `PRAGMA optimize` finds missing or out of date, except the
 * drained ones. One table per statement: a first analysis of a cold 6 GB file took 1 to 5
 * seconds, and between two tables the app's own statements take the connection.
 */
export const refreshPlannerStatistics = Effect.fnUntraced(function* (scope: Scope) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA analysis_limit = ${sql.literal(String(analysisLimit))}`;
  // Bit 0x1 lists the ANALYZE statements instead of running them; 0x10000 looks at every table.
  const planned = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Planned,
    execute: () => (scope === "all" ? sql`PRAGMA optimize(0x10003)` : sql`PRAGMA optimize(0x3)`),
  })();
  yield* Effect.forEach(
    planned.filter(
      ({ optimize }) =>
        !Option.exists(analyzedTable(optimize), (table) => HashSet.has(drainedTables, table)),
    ),
    ({ optimize }) => sql.unsafe(optimize),
    { discard: true },
  );
});

const warned = Effect.catch((error: { readonly _tag: string }) =>
  // Logs carry the tag only: causes hold SQL.
  Effect.logWarning("Planner statistics not refreshed", { error: error._tag }),
);

/**
 * Refreshes every table's statistics once the app starts, then the tables queried since every
 * hour. A failed refresh leaves the statistics as they were until the next one.
 */
export const PlannerStatistics = {
  layer: Layer.effectDiscard(
    Effect.forkScoped(
      warned(refreshPlannerStatistics("all")).pipe(
        Effect.andThen(
          warned(refreshPlannerStatistics("used")).pipe(Effect.delay(checkEvery), Effect.forever),
        ),
      ),
    ),
  ),
};
