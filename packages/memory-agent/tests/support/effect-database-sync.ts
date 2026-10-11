import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Effect, Layer, Schema, Stream, Result, Function as EffectFunction } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const failure = (cause: unknown, operation: string) =>
  SqlError.make({
    reason: UnknownError.make({
      cause,
      message: cause instanceof Error ? cause.message : String(cause),
      operation,
    }),
  });

const SqliteParameter = Schema.Union([
  Schema.Null,
  Schema.Finite,
  Schema.BigInt,
  Schema.String,
  Schema.Uint8Array,
]);
const isBoolean = Schema.is(Schema.Boolean);
const decodeParameter = EffectFunction.flow(
  Schema.decodeUnknownResult(SqliteParameter),
  Result.getOrThrow,
);
const parameters = (values: ReadonlyArray<unknown>) =>
  values.map((value) => (isBoolean(value) ? (value ? 1 : 0) : decodeParameter(value)));

const prepare = (sqlite: DatabaseSync, sql: string) => {
  const statement = sqlite.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
};

const rows = (statement: StatementSync, values: ReadonlyArray<unknown>) =>
  statement.all(...parameters(values));

/** Test-only adapter that lends Effect SQL the owner's one DatabaseSync connection. */
export const effectDatabaseSyncLayer = (sqlite: DatabaseSync) => {
  const run = (sql: string, values: ReadonlyArray<unknown>) =>
    Effect.try({
      try: () => rows(prepare(sqlite, sql), values),
      catch: (cause) => failure(cause, "execute"),
    });
  const runValues = (sql: string, values: ReadonlyArray<unknown>) =>
    Effect.map(run(sql, values), (result) => result.map((row) => Object.values(row)));
  const connection: SqlConnection.Connection = {
    execute: (sql, values, transformRows) =>
      Effect.map(run(sql, values), (result) =>
        transformRows === undefined ? result : transformRows(result),
      ),
    executeRaw: run,
    executeStream: (sql, values, transformRows) =>
      Stream.unwrap(
        Effect.map(run(sql, values), (result) =>
          Stream.fromIterable(transformRows === undefined ? result : transformRows(result)),
        ),
      ),
    executeValues: runValues,
    executeValuesUnprepared: runValues,
    executeUnprepared: (sql, values, transformRows) =>
      Effect.map(run(sql, values), (result) =>
        transformRows === undefined ? result : transformRows(result),
      ),
  };
  return Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer: Effect.succeed(connection),
      borrower: (use) => use(connection),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [["db.system", "sqlite"]],
      beginTransaction: "BEGIN IMMEDIATE",
      prepareTransactionControls: false,
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    }),
  ).pipe(Layer.provide(Reactivity.layer));
};
