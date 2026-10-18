import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Result,
  Scheduler,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/sql";

/** Values node:sqlite binds; the compiler's output is decoded at this boundary. */
const SqlParameters = Schema.Array(
  Schema.Union([Schema.String, Schema.Finite, Schema.BigInt, Schema.Null, Schema.Uint8Array]),
);

const sqlError = (cause: unknown) =>
  SqlError.SqlError.make({ reason: SqlError.classifySqliteError(cause) });

/**
 * The application's one SQLite connection as an Effect `SqlClient`. It never opens a second
 * database: two connections would let a transaction suspended on one block the other's
 * synchronous `BEGIN IMMEDIATE` on the event loop. Every statement and transaction leases the
 * connection through `semaphore`, so one fibre's transaction never absorbs another's statements.
 */
export const sqlClientOver = Effect.fn("sqlClientOver")(function* (
  sqlite: DatabaseSync,
  semaphore: Semaphore.Semaphore,
) {
  const prepare = (sql: string) => Effect.try({ try: () => sqlite.prepare(sql), catch: sqlError });
  const statements = yield* Cache.makeWith(prepare, {
    capacity: 200,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
  });
  /** Binds decoded parameters with this fibre's integer mode, then runs `work`. */
  const bound = <A>(
    statement: StatementSync,
    params: ReadonlyArray<unknown>,
    work: (inputs: typeof SqlParameters.Type) => A,
  ) =>
    Effect.withFiber<A, SqlError.SqlError>((fiber) =>
      Effect.try({
        try: () => {
          const inputs = Result.getOrThrow(Schema.decodeUnknownResult(SqlParameters)(params));
          statement.setReadBigInts(Context.get(fiber.context, SqlClient.SafeIntegers));
          return work(inputs);
        },
        catch: sqlError,
      }),
    );
  const rows = (statement: StatementSync, params: ReadonlyArray<unknown>) =>
    bound(statement, params, (inputs) => statement.all(...inputs));
  const values = (statement: StatementSync, params: ReadonlyArray<unknown>) =>
    bound(statement, params, (inputs) => {
      statement.setReturnArrays(true);
      try {
        return statement.all(...inputs).map((row) => Object.values(row));
      } finally {
        statement.setReturnArrays(false);
      }
    });
  const raw = (statement: StatementSync, params: ReadonlyArray<unknown>) =>
    bound(statement, params, (inputs) => {
      if (statement.columns().length > 0) return statement.all(...inputs);
      const result = statement.run(...inputs);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    });
  const cached = (sql: string) => Cache.get(statements, sql);
  const transformed = (
    effect: Effect.Effect<ReadonlyArray<object>, SqlError.SqlError>,
    transform: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined,
  ) => Effect.map(effect, (found) => (transform === undefined ? found : transform(found)));

  const connection: SqlConnection.Connection & { readonly isTransaction: () => boolean } = {
    isTransaction: () => sqlite.isTransaction,
    execute: (sql, params, transform) =>
      transformed(
        Effect.flatMap(cached(sql), (statement) => rows(statement, params)),
        transform,
      ),
    executeRaw: (sql, params) => Effect.flatMap(cached(sql), (statement) => raw(statement, params)),
    executeStream: (sql, params, transform) =>
      Stream.fromIterableEffect(
        transformed(
          Effect.flatMap(cached(sql), (statement) => rows(statement, params)),
          transform,
        ),
      ),
    executeValues: (sql, params) =>
      Effect.flatMap(cached(sql), (statement) => values(statement, params)),
    executeValuesUnprepared: (sql, params) =>
      Effect.flatMap(prepare(sql), (statement) => values(statement, params)),
    // Transaction control and multi-statement scripts arrive without parameters.
    executeUnprepared: (sql, params, transform) =>
      params.length === 0
        ? Effect.as(Effect.try({ try: () => sqlite.exec(sql), catch: sqlError }), [])
        : transformed(
            Effect.flatMap(prepare(sql), (statement) => rows(statement, params)),
            transform,
          ),
  };
  const { acquirer, transactionAcquirer, onCommitFailure } = SqlClient.makeSqliteAcquirers({
    connection: Effect.succeed(connection),
    semaphore,
    isTransaction: (current) => current.isTransaction(),
  });
  const client = yield* SqlClient.make({
    acquirer,
    transactionAcquirer,
    onCommitFailure,
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [["db.system", "sqlite"]],
    beginTransaction: "BEGIN IMMEDIATE",
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
  }).pipe(Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make));
  // Legacy synchronous SQL on this connection bypasses the lease. A transaction body made only of
  // statements must therefore not be preempted by the scheduler's operation budget, or that SQL
  // would run inside it. Explicit asynchronous waits inside a transaction still yield.
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <R, E, A>(self: Effect.Effect<A, E, R>) =>
      withTransaction(Effect.provideService(self, Scheduler.PreventSchedulerYield, true)),
  });
});
