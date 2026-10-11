import { Result, Function as EffectFunction } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { DatabaseSync } from "node:sqlite";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { goalHistoryMigration, migrations } from "./migrations.ts";
import { migrationClient } from "./migration-client.ts";

export class DatabaseOpenError extends Data.TaggedError("DatabaseOpenError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

interface DatabaseApi {
  readonly sqlite: DatabaseSync;
  /** Runs synchronous SQL work in one transaction; nested calls join the outer one. */
  readonly atomic: <T>(work: () => T) => T;
}

const UserVersion = Schema.Struct({ user_version: Schema.Finite });

/** Startup-only: call before handing this connection to any service or writer. */
export function migrateDatabase(sqlite: DatabaseSync) {
  if (sqlite.isTransaction) throw new Error("Database migration requires a standalone transaction");
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
      throw new Error(
        `Database schema ${applied} is newer than this build (${migrations.length}); update the app before opening it`,
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
      for (let version = 1; version <= applied; version++) adopt.run(version, `schema_${version}`);
    const recorded = sqlite
      .prepare("SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    if (
      recorded.length !== applied ||
      recorded.some((row, index) => row.migration_id !== index + 1)
    )
      throw new Error("Database migration metadata disagrees with user_version");
    const loader = Effect.succeed(
      migrations.map(
        (step, index) =>
          [
            index + 1,
            `schema_${index + 1}`,
            Effect.succeed(
              Effect.sync(() => {
                const rebuild = index + 1 === goalHistoryMigration.version;
                const before = rebuild ? snapshot() : [];
                sqlite.exec(step);
                if (rebuild) {
                  const after = snapshot();
                  if (before.some((rows, table) => rows !== after[table]))
                    throw new Error("Goal history migration changed preserved rows");
                  if (sqlite.prepare("PRAGMA foreign_key_check").all().length !== 0)
                    throw new Error("Goal history migration has invalid foreign key references");
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
      throw new Error("Database migration has invalid foreign key references");
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
    throw new Error(
      `Database schema ${actual} is newer than this build (${migrations.length}); update the app before opening it`,
    );
  if (actual < migrations.length)
    throw new Error(
      `Database schema ${actual} needs the owning app to migrate to ${migrations.length} before readers start`,
    );
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
      .pipe(Effect.mapError((cause) => new DatabaseOpenError({ file, cause })));
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
      catch: (cause) => new DatabaseOpenError({ file, cause }),
    }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  ).pipe(
    Effect.map((sqlite): DatabaseApi => {
      let depth = 0;
      return {
        sqlite,
        atomic(work) {
          const outermost = depth === 0;
          const savepoint = `atomic_${depth}`;
          sqlite.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
          depth += 1;
          try {
            const result = work();
            sqlite.exec(outermost ? "COMMIT" : `RELEASE ${savepoint}`);
            return result;
          } catch (error) {
            sqlite.exec(outermost ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
            throw error;
          } finally {
            depth -= 1;
          }
        },
      };
    }),
  );
});

/** The single local SQLite database shared by every memory-agent module. */
export class Database extends Context.Service<Database, DatabaseApi>()("memory-agent/db/database") {
  static readonly layer = (
    file: string,
    open: (file: string) => DatabaseSync = (file) => new DatabaseSync(file),
  ) =>
    Layer.effect(Database, make(file, open)).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    );
}
