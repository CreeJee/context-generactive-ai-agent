import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { migrations } from "./migrations.ts";

export class DatabaseOpenError extends Data.TaggedError("DatabaseOpenError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

interface DatabaseApi {
  readonly sqlite: DatabaseSync;
  /** Runs synchronous SQL work in one transaction; nested calls join the outer one. */
  readonly atomic: <T>(work: () => T) => T;
}

const UserVersion = Schema.Struct({ user_version: Schema.Number });

function migrate(sqlite: DatabaseSync) {
  const { user_version: applied } = Schema.decodeUnknownSync(UserVersion)(
    sqlite.prepare("PRAGMA user_version").get(),
  );
  if (applied > migrations.length)
    throw new Error(`Database schema ${applied} is newer than this build (${migrations.length})`);
  for (const [index, step] of migrations.entries()) {
    if (index < applied) continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(step);
      sqlite.exec(`PRAGMA user_version = ${index + 1}`);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const make = (file: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const sqlite = new DatabaseSync(file);
        try {
          sqlite.exec("PRAGMA journal_mode = WAL");
          sqlite.exec("PRAGMA foreign_keys = ON");
          sqlite.exec("PRAGMA busy_timeout = 5000");
          // Up to 64 MiB of pages instead of 2: updating the trigram index reads and rewrites many of
          // them, and a bulk write took a fifth less time (docs/decisions.md).
          sqlite.exec("PRAGMA cache_size = -65536");
          migrate(sqlite);
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
          const savepoint = `atomic_${depth}`;
          sqlite.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
          depth += 1;
          try {
            const result = work();
            depth -= 1;
            sqlite.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
            return result;
          } catch (error) {
            depth -= 1;
            sqlite.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`);
            throw error;
          }
        },
      };
    }),
  );

/** The single local SQLite database shared by every memory-agent module. */
export class Database extends Context.Service<Database, DatabaseApi>()("memory-agent/Database") {
  static readonly layer = (file: string) => Layer.effect(Database, make(file));
}
