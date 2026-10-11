import type { DatabaseSync } from "node:sqlite";
import { Effect, Result, Schema, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/sql";

const Parameters = Schema.Array(
  Schema.Union([Schema.String, Schema.Finite, Schema.BigInt, Schema.Null, Schema.Uint8Array]),
);

/** Startup adapter over the already-owned connection; it never opens a second database. */
export const migrationClient = Effect.fn("migrationClient")(function* (sqlite: DatabaseSync) {
  const attempt = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (cause) => SqlError.SqlError.make({ reason: SqlError.classifySqliteError(cause) }),
    });
  const execute: SqlConnection.Connection["execute"] = (sql, params, transform) =>
    attempt(() => {
      const inputs = Result.getOrThrow(Schema.decodeUnknownResult(Parameters)(params));
      const rows = sqlite.prepare(sql).all(...inputs);
      return transform === undefined ? rows : transform(rows);
    });
  const executeValues: SqlConnection.Connection["executeValues"] = (sql, params) =>
    Effect.map(execute(sql, params, undefined), (rows) => rows.map(Object.values));
  const connection: SqlConnection.Connection = {
    execute,
    executeRaw: (sql, params) => execute(sql, params, undefined),
    executeStream: (sql, params, transform) =>
      Stream.fromIterableEffect(execute(sql, params, transform)),
    executeValues,
    executeValuesUnprepared: executeValues,
    executeUnprepared: (sql, params, transform) =>
      params.length === 0
        ? Effect.as(
            attempt(() => sqlite.exec(sql)),
            [],
          )
        : execute(sql, params, transform),
  };
  const reactivity = yield* Reactivity.make;
  return yield* SqlClient.make({
    acquirer: Effect.succeed(connection),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [["db.system", "sqlite"]],
    // The owning startup transaction already holds BEGIN IMMEDIATE before any metadata read.
    beginTransaction: "SAVEPOINT effect_migrate",
    commit: "RELEASE effect_migrate",
    rollback: "ROLLBACK TO effect_migrate; RELEASE effect_migrate",
  }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
});
