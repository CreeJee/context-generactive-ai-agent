import { Effect, Layer, Schedule, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/**
 * Hands the database's free pages back to the file system a little at a time, so a deleted
 * conversation shrinks the file without a full `VACUUM` stopping the app. Only a file made with
 * incremental auto_vacuum can do this; an older one keeps its free pages for later writes
 * (docs/decisions.md "새 DB는 빈 페이지를 조금씩 돌려준다 (2026-11-04)").
 */

/** `PRAGMA auto_vacuum` of a file made with `auto_vacuum = INCREMENTAL`. */
const incremental = 2;
/** 1 MiB of 4 KiB pages; returning one batch took under a millisecond. */
const batchPages = 256;
/** Free pages a write soon reuses; fewer than this are not worth returning. */
const keptPages = 1024;
/** Between batches the app's own statements take the connection. */
const batchPause = "100 millis";
const checkEvery = "10 minutes";

const PragmaValue = Schema.Struct({ value: Schema.Finite });

/** Returns free pages in batches until fewer than `keptPages` are left. */
export const reclaimFreePages = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const freePages = SqlSchema.findOne({
    Request: Schema.Void,
    Result: PragmaValue,
    execute: () => sql`SELECT freelist_count AS value FROM pragma_freelist_count`,
  });
  const batch = Effect.gen(function* () {
    if ((yield* freePages()).value < keptPages) return false;
    yield* sql`PRAGMA incremental_vacuum(${sql.literal(String(batchPages))})`;
    yield* Effect.sleep(batchPause);
    return true;
  });
  yield* batch.pipe(Effect.repeat({ while: (more) => more }));
});

/** Whether the file was made with incremental auto_vacuum and can return free pages. */
const canReclaim = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mode = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: PragmaValue,
    execute: () => sql`SELECT auto_vacuum AS value FROM pragma_auto_vacuum`,
  })();
  return mode.value === incremental;
});

/** Checks every ten minutes for free pages to return. A failed check waits for the next one. */
export const FreePages = {
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const loop = reclaimFreePages().pipe(
        // Logs carry the tag only: causes hold SQL.
        Effect.catch((error) =>
          Effect.logWarning("Free pages not returned", { error: error._tag }),
        ),
        Effect.repeat(Schedule.spaced(checkEvery)),
      );
      yield* Effect.when(Effect.forkScoped(loop), canReclaim);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Free page check not started", { error: error._tag }),
      ),
    ),
  ),
};
