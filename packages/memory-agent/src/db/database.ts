import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { mkdirSync } from "node:fs";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { goalHistoryMigration, migrations } from "./migrations.ts";

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
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const { user_version: applied } = EffectFunction.flow(
    Schema.decodeUnknownResult(UserVersion),
    Result.getOrThrow,
  )(sqlite.prepare("PRAGMA user_version").get());
  if (applied > migrations.length)
    throw new Error(`Database schema ${applied} is newer than this build (${migrations.length})`);
  for (const [index, step] of migrations.entries()) {
    if (index < applied) continue;
    const rebuild = index + 1 === goalHistoryMigration.version;
    // Snapshot values, counts and dependent receipts before the only permitted rebuild.
    const snapshot = () =>
      goalHistoryMigration.preservedTables.map((table) =>
        JSON.stringify(
          sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          (_key, value) => (Schema.is(Schema.BigInt)(value) ? value.toString() : value),
        ),
      );
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    const foreignKeys = EffectFunction.flow(
      Schema.decodeUnknownResult(Schema.Struct({ foreign_keys: Schema.Finite })),
      Result.getOrThrow,
    )(sqlite.prepare("PRAGMA foreign_keys").get()).foreign_keys;
    if (rebuild) sqlite.exec("PRAGMA foreign_keys = OFF");
    let started = false;
    try {
      sqlite.exec("BEGIN IMMEDIATE");
      started = true;
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
      sqlite.exec("COMMIT");
      started = false;
    } catch (error) {
      if (started) sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      if (rebuild) sqlite.exec(`PRAGMA foreign_keys = ${isTruthy(foreignKeys) ? "ON" : "OFF"}`);
    }
  }
}

const make = (file: string, open: (file: string) => DatabaseSync) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
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

/** The single local SQLite database shared by every memory-agent module. */
export class Database extends Context.Service<Database, DatabaseApi>()("memory-agent/db/database") {
  static readonly layer = (
    file: string,
    open: (file: string) => DatabaseSync = (file) => new DatabaseSync(file),
  ) => Layer.effect(Database, make(file, open));
}
