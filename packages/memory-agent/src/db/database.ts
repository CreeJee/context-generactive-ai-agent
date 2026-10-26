import { Result, Function as EffectFunction } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { goalHistoryMigration, migrations } from "./migrations.ts";
import { migrationClient } from "./migration-client.ts";
import { sqlClientOver } from "./sql-client.ts";

export class DatabaseOpenError extends Schema.TaggedError<DatabaseOpenError>()(
  "DatabaseOpenError",
  { file: Schema.String, cause: Schema.Defect() },
) {}

/**
 * Why a connection's schema cannot be used by this build. Thrown by the synchronous startup and
 * reader checks, which run before any Effect owns the connection; `make` carries it as the cause of
 * `DatabaseOpenError`. A failing SQL step keeps SQLite's own error.
 */
export const DatabaseSchemaRejectedReason = Schema.TaggedUnion({
  /** Migration was asked to run inside a transaction it cannot own. */
  InsideTransaction: {},
  /** The file was written by a newer build. */
  NewerThanBuild: { actual: Schema.Finite, supported: Schema.Finite },
  /** A reader found a schema the owning app has not migrated yet. */
  MigrationPending: { actual: Schema.Finite, supported: Schema.Finite },
  MetadataMismatch: {},
  /** The goal history rebuild changed rows it must preserve. */
  PreservedRowsChanged: {},
  InvalidForeignKeys: {},
});

export class DatabaseSchemaRejected extends Schema.TaggedError<DatabaseSchemaRejected>()(
  "DatabaseSchemaRejected",
  { reason: DatabaseSchemaRejectedReason },
) {}

const schemaRejection = DatabaseSchemaRejectedReason.cases;
const rejected = (reason: DatabaseSchemaRejected["reason"]) =>
  DatabaseSchemaRejected.make({ reason });

const UserVersion = Schema.Struct({ user_version: Schema.Finite });

/** Startup-only: call before handing this connection to any service or writer. */
export function migrateDatabase(sqlite: DatabaseSync) {
  if (sqlite.isTransaction) throw rejected(schemaRejection.InsideTransaction.make({}));
  const foreignKeys = EffectFunction.flow(
    Schema.decodeUnknownResult(Schema.Struct({ foreign_keys: Schema.Finite })),
    Result.getOrThrow,
  )(sqlite.prepare("PRAGMA foreign_keys").get()).foreign_keys;
  // Startup owns this connection. FK suspension permits the historical referenced-table rebuild;
  // every pending step and its version cursor commit together, and FK validity is checked before commit.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  let started = false;
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    started = true;
    // Read the authority only after taking the migration lock: another starter may have completed it.
    const applied = databaseSchemaVersion(sqlite);
    if (applied > migrations.length)
      throw rejected(
        schemaRejection.NewerThanBuild.make({ actual: applied, supported: migrations.length }),
      );
    const snapshot = () =>
      goalHistoryMigration.preservedTables.map((table) =>
        JSON.stringify(
          sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          (_key, value) => (Schema.is(Schema.BigInt)(value) ? value.toString() : value),
        ),
      );
    // Adopt the released user_version cursor without replaying historical SQL. Metadata adoption,
    // pending migrations and the original cursor all roll back together on startup failure.
    const hasMetadata =
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
        )
        .get() !== undefined;
    sqlite.exec(`CREATE TABLE IF NOT EXISTS effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )`);
    const adopt = sqlite.prepare(
      "INSERT OR IGNORE INTO effect_sql_migrations (migration_id,name) VALUES (?,?)",
    );
    if (!hasMetadata)
      Array.from({ length: applied }, (_, index) => index + 1).forEach((version) =>
        adopt.run(version, `schema_${version}`),
      );
    const recorded = sqlite
      .prepare("SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    if (
      recorded.length !== applied ||
      recorded.some((row, index) => row.migration_id !== index + 1)
    )
      throw rejected(schemaRejection.MetadataMismatch.make({}));
    const loader = Effect.succeed(
      migrations.map(
        (step, index) =>
          [
            index + 1,
            `schema_${index + 1}`,
            // The Migrator turns a step's failure into a generic defect; throwing keeps the reason
            // as the defect itself, so `migrateDatabase` rethrows it unchanged.
            Effect.succeed(
              Effect.sync(() => {
                const rebuild = index + 1 === goalHistoryMigration.version;
                const before = rebuild ? snapshot() : [];
                sqlite.exec(step);
                if (rebuild) {
                  const after = snapshot();
                  if (before.some((rows, table) => rows !== after[table]))
                    throw rejected(schemaRejection.PreservedRowsChanged.make({}));
                  if (sqlite.prepare("PRAGMA foreign_key_check").all().length !== 0)
                    throw rejected(schemaRejection.InvalidForeignKeys.make({}));
                }
                sqlite.exec(`PRAGMA user_version = ${index + 1}`);
              }),
            ),
          ] as const,
      ),
    );
    Effect.runSync(
      Effect.flatMap(migrationClient(sqlite), (client) =>
        Migrator.make({})({ loader }).pipe(Effect.provideService(SqlClient.SqlClient, client)),
      ),
    );
    if (
      applied < migrations.length &&
      sqlite.prepare("PRAGMA foreign_key_check").all().length !== 0
    )
      throw rejected(schemaRejection.InvalidForeignKeys.make({}));
    assertDatabaseSchema(sqlite);
    sqlite.exec("COMMIT");
    started = false;
  } catch (error) {
    if (started) sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.exec(`PRAGMA foreign_keys = ${foreignKeys === 1 ? "ON" : "OFF"}`);
  }
}

export const databaseSchemaVersion = (sqlite: DatabaseSync) =>
  EffectFunction.flow(
    Schema.decodeUnknownResult(UserVersion),
    Result.getOrThrow,
  )(sqlite.prepare("PRAGMA user_version").get()).user_version;

/** Read-only worker entry: the owner migrates; readers never assume a cached schema version. */
export function assertDatabaseSchema(sqlite: DatabaseSync) {
  const actual = databaseSchemaVersion(sqlite);
  if (actual > migrations.length)
    throw rejected(schemaRejection.NewerThanBuild.make({ actual, supported: migrations.length }));
  if (actual < migrations.length)
    throw rejected(schemaRejection.MigrationPending.make({ actual, supported: migrations.length }));
  // A version cursor cannot make a missing runtime contract safe; detect damage before execution.
  sqlite.prepare("SELECT run_id,thread_id,status FROM chat_runs LIMIT 0");
  sqlite.prepare(
    "SELECT run_id,workflow_revision_id,goal_instance_id FROM workflow_run_bindings LIMIT 0",
  );
  sqlite.prepare(
    "SELECT receipt_id,authorization_fingerprint,execution_payload_json FROM owner_read_recoveries LIMIT 0",
  );
  sqlite.prepare("SELECT id,seq,project_id,session_id,kind,text FROM nodes LIMIT 0");
  return actual;
}

const make = Effect.fn("Database.make")(function* (
  file: string,
  open: (file: string) => DatabaseSync,
) {
  if (file !== ":memory:") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => DatabaseOpenError.make({ file, cause })));
  }
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const sqlite = open(file);
        try {
          sqlite.exec("PRAGMA journal_mode = WAL");
          sqlite.exec("PRAGMA foreign_keys = ON");
          sqlite.exec("PRAGMA busy_timeout = 5000");
          // Up to 64 MiB of pages instead of 2: updating the trigram index reads and rewrites many of
          // them, and a bulk write took a fifth less time (docs/decisions.md).
          sqlite.exec("PRAGMA cache_size = -65536");
          migrateDatabase(sqlite);
          return sqlite;
        } catch (error) {
          sqlite.close();
          throw error;
        }
      },
      catch: (cause) => DatabaseOpenError.make({ file, cause }),
    }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  ).pipe(Effect.flatMap(connectionContext));
});

/**
 * `SqlClient` over one open, migrated connection. The caller owns the connection; the app's layer
 * opens it, and tests pass the connection a fixture made. Every statement and transaction leases
 * the connection, so no code reaches it except through the client.
 */
export const connectionContext = Effect.fn("Database.connectionContext")(function* (
  sqlite: DatabaseSync,
) {
  return Context.make(SqlClient.SqlClient, yield* sqlClientOver(sqlite, yield* Semaphore.make(1)));
});

/** The single local SQLite database shared by every memory-agent module, as its `SqlClient`. */
export const Database = {
  layer: (file: string, open: (file: string) => DatabaseSync = (file) => new DatabaseSync(file)) =>
    Layer.effectContext(make(file, open)).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    ),

  /** Over a connection the caller opened and migrated, as fixtures do. */
  over: <E, R>(sqlite: Effect.Effect<DatabaseSync, E, R>) =>
    Layer.effectContext(Effect.flatMap(sqlite, connectionContext)),
};
