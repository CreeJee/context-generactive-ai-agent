/**
 * `memory compact`: shrinks the database file with one full `VACUUM`, which also turns a file made
 * before 2026-11-04 into one that returns its free pages a little at a time (`FreePages`,
 * docs/decisions.md "DB 파일 줄이기는 앱을 닫고 CLI로 한다 (2026-11-09)").
 *
 * The app never runs it: its one connection is synchronous, so a `VACUUM` stops every request for
 * as long as it takes, 41 s on a 6.3 GB copy. Here it runs with the app's `backend.lock`, and
 * refuses with `StorageLockHeld` while the app owns the folder.
 */
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { Database } from "../db/database.ts";
import { lockStorageRoot } from "../runtime/storage-lock.ts";
import { path } from "../runtime/synchronous-path.ts";
import { CliFailure } from "./project-reference.ts";

const PragmaValue = Schema.Struct({ value: Schema.Finite });

/** The database's size and how much of it is free pages, in bytes. */
const measure = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sizes = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ pageSize: Schema.Finite, pages: Schema.Finite, free: Schema.Finite }),
    execute: () => sql`SELECT
      (SELECT page_size FROM pragma_page_size) AS pageSize,
      (SELECT page_count FROM pragma_page_count) AS pages,
      (SELECT freelist_count FROM pragma_freelist_count) AS free`,
  })();
  return { bytes: sizes.pages * sizes.pageSize, freeBytes: sizes.free * sizes.pageSize };
});

/** Whether the file returns its free pages a little at a time (`auto_vacuum = INCREMENTAL`). */
const incremental = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mode = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: PragmaValue,
    execute: () => sql`SELECT auto_vacuum AS value FROM pragma_auto_vacuum`,
  })();
  return mode.value === 2;
});

/** Rewrites the storage's database without its free pages; the sizes before and after. */
export const compactStorage = Effect.fn("compactStorage")(function* (storage: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(storage, "agent.db");
  yield* Effect.when(
    Effect.fail(CliFailure.make({ code: "storage_not_found", detail: { storage } })),
    Effect.map(fs.exists(file), (exists) => !exists),
  );
  // Before the database opens: the lock keeps the app out until this scope closes.
  yield* lockStorageRoot({
    storageRoot: storage,
    port: 0,
    instanceId: SecureRandom.uuidV4Unsafe(),
  });
  // Opening migrates the file, as the app would on its next start.
  const sql = Context.get(yield* Layer.build(Database.layer(file)), SqlClient.SqlClient);
  return yield* Effect.gen(function* () {
    const before = { ...(yield* measure), incremental: yield* incremental };
    // The mode changes only with a `VACUUM`, which rewrites the file in it.
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
    yield* sql`VACUUM`;
    // The rewritten pages wait in the WAL until a checkpoint moves them into the file.
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const after = { ...(yield* measure), incremental: yield* incremental };
    return { storage, before, after };
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    // A full disk is the likely cause: the rewrite needs room for a second copy of the file.
    Effect.catchTag("SqlError", (error) =>
      Effect.fail(
        CliFailure.make({ code: "compact_failed", detail: { cause: String(error.cause) } }),
      ),
    ),
  );
});
