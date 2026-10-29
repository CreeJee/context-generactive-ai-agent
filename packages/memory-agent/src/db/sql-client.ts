import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Cache, Context, Duration, Effect, Exit, Predicate, Result } from "effect";
import { Schedule, Schema, Semaphore, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/sql";

/** Values node:sqlite binds; the compiler's output is decoded at this boundary. */
const SqlParameters = Schema.Array(
  Schema.Union([Schema.String, Schema.Finite, Schema.BigInt, Schema.Null, Schema.Uint8Array]),
);

/** node:sqlite reports SQLite's result code as `errcode`, which `classifySqliteError` does not read. */
const SqliteResultCode = Schema.Struct({ errcode: Schema.Int });
/** `SQLITE_BUSY`, the primary code of its extended codes: another connection holds the lock. */
const sqliteBusy = 5;

const sqlError = (cause: unknown) =>
  SqlError.SqlError.make({
    reason:
      Schema.is(SqliteResultCode)(cause) && cause.errcode % 256 === sqliteBusy
        ? SqlError.LockTimeoutError.make({ cause })
        : SqlError.classifySqliteError(cause),
  });

const beginTransaction = "BEGIN IMMEDIATE";

/**
 * Another connection's lock is waited out between attempts, never inside SQLite, whose wait
 * (`busy_timeout`, 0 here) blocks the thread. A failed attempt only looks at the lock, so it asks
 * often: at most every 30ms with jitter, for up to half a minute. The import worker's long writes
 * take their turn on this connection instead (`imports/write-turns.ts`); what is left to wait out
 * here are its brief ones.
 */
const lockRetry = Schedule.max([
  Schedule.min([Schedule.exponential("5 millis"), Schedule.spaced("25 millis")]),
  Schedule.during("30 seconds"),
]).pipe(Schedule.jittered);

/**
 * The application's one SQLite connection as an Effect `SqlClient`. It never opens a second
 * database: two connections would let a transaction suspended on one block the other's
 * synchronous `BEGIN IMMEDIATE` on the event loop. Every statement and transaction leases the
 * connection through `semaphore`, so one fibre's transaction never absorbs another's statements.
 *
 * The import worker still writes through a connection of its own. While it holds the write lock,
 * a `BEGIN IMMEDIATE` or a statement outside a transaction fails at once and is tried again after
 * a sleep, so the event loop keeps serving instead of waiting inside SQLite. Neither changed
 * anything when it failed; a statement inside a transaction is not tried again.
 */
export const sqlClientOver = Effect.fn("sqlClientOver")(function* (
  sqlite: DatabaseSync,
  semaphore: Semaphore.Semaphore,
) {
  yield* Effect.try({ try: () => sqlite.exec("PRAGMA busy_timeout = 0"), catch: sqlError });
  const waitingForLock = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
    Effect.retry(effect, {
      schedule: lockRetry,
      while: (error) =>
        Predicate.isTagged(error.reason, "LockTimeoutError") && !sqlite.isTransaction,
    });
  const exec = (sql: string) => Effect.try({ try: () => sqlite.exec(sql), catch: sqlError });
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
    waitingForLock(
      Effect.withFiber<A, SqlError.SqlError>((fiber) =>
        Effect.try({
          try: () => {
            const inputs = Result.getOrThrow(Schema.decodeUnknownResult(SqlParameters)(params));
            statement.setReadBigInts(Context.get(fiber.context, SqlClient.SafeIntegers));
            return work(inputs);
          },
          catch: sqlError,
        }),
      ),
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
    // Transaction control and multi-statement scripts arrive without parameters. A script may have
    // run part of itself before failing on the lock, so only the BEGIN is tried again.
    executeUnprepared: (sql, params, transform) =>
      params.length === 0
        ? Effect.as(sql === beginTransaction ? waitingForLock(exec(sql)) : exec(sql), [])
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
  return yield* SqlClient.make({
    acquirer,
    transactionAcquirer,
    onCommitFailure,
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [["db.system", "sqlite"]],
    beginTransaction,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
  }).pipe(Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make));
});
