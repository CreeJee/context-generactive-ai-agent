import { Context, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** Values SQLite stores and returns. */
type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;

/**
 * The client of the agent a test has open now. `TestEnv` sets it, so fixture SQL follows
 * `reopen` instead of reaching the closed agent's connection.
 */
export const OpenSqlClient = Context.Reference<Option.Option<Effect.Effect<SqlClient.SqlClient>>>(
  "memory-agent/tests/support/sql/OpenSqlClient",
  { defaultValue: Option.none },
);

const client = Effect.gen(function* () {
  const open = yield* OpenSqlClient;
  if (Option.isSome(open)) return yield* open.value;
  return yield* SqlClient.SqlClient;
});

const RunResult = Schema.Struct({
  changes: Schema.Union([Schema.Finite, Schema.BigInt]),
  lastInsertRowid: Schema.Union([Schema.Finite, Schema.BigInt]),
});

/** Fixture seeding and inspection through the app's `SqlClient`, with `?` placeholders. */
export const sqlAll = (query: string, ...params: ReadonlyArray<SqlValue>) =>
  Effect.flatMap(client, (sql) => sql.unsafe<SqlRow>(query, params));

export const sqlGet = (query: string, ...params: ReadonlyArray<SqlValue>) =>
  Effect.map(sqlAll(query, ...params), (rows) => rows.at(0));

export const sqlRun = (query: string, ...params: ReadonlyArray<SqlValue>) =>
  Effect.flatMap(client, (sql) => sql.unsafe(query, params).raw).pipe(
    Effect.flatMap((result) => Effect.orDie(Schema.decodeUnknownEffect(RunResult)(result))),
  );

/** A multi-statement script without parameters. */
export const sqlExec = (script: string) =>
  Effect.flatMap(client, (sql) => sql.unsafe(script).unprepared).pipe(Effect.asVoid);

/** Runs `effect` in one transaction on the open agent's `SqlClient`. */
export const sqlTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(client, (sql) => sql.withTransaction(effect));

/** Runs an app Effect that needs a `SqlClient` on the open agent's. */
export const withOpenSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(client, (sql) => Effect.provideService(effect, SqlClient.SqlClient, sql));
