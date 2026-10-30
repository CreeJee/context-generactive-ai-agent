import { NodeServices } from "@effect/platform-node";
import { DatabaseSync } from "node:sqlite";
import { Clock, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "./database.ts";

it.effect("keeps another fibre's statement out of a suspended transaction", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE sql_client_fixture(id INTEGER PRIMARY KEY)`;
    const opened = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const transaction = yield* Effect.forkChild(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO sql_client_fixture VALUES (1)`;
          yield* Deferred.succeed(opened, undefined);
          yield* Deferred.await(release);
          return yield* Effect.fail("rolled back" as const);
        }),
      ),
    );
    yield* Deferred.await(opened);
    const outside = yield* Effect.forkChild(sql`INSERT INTO sql_client_fixture VALUES (2)`, {
      startImmediately: true,
    });
    // The second statement waits for the lease instead of running inside the open transaction.
    expect(outside.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(transaction).pipe(Effect.flip)).toBe("rolled back");
    yield* Fiber.join(outside);
    expect(yield* sql`SELECT id FROM sql_client_fixture ORDER BY id`).toEqual([{ id: 2 }]);
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("rolls back a failed nested transaction without discarding outer work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE nested_fixture(id INTEGER PRIMARY KEY)`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO nested_fixture VALUES (1)`;
        const nested = yield* sql
          .withTransaction(
            sql`INSERT INTO nested_fixture VALUES (2)`.pipe(
              Effect.andThen(Effect.fail("nested failed" as const)),
            ),
          )
          .pipe(Effect.flip);
        expect(nested).toBe("nested failed");
        yield* sql.withTransaction(sql`INSERT INTO nested_fixture VALUES (3)`);
      }),
    );
    expect(yield* sql`SELECT id FROM nested_fixture ORDER BY id`).toEqual([{ id: 1 }, { id: 3 }]);
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("reports a deferred COMMIT failure, rolls back and permits the next transaction", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE parent_fixture(id INTEGER PRIMARY KEY)`;
    yield* sql`CREATE TABLE child_fixture(parent_id INTEGER REFERENCES parent_fixture(id) DEFERRABLE INITIALLY DEFERRED)`;
    const failed = yield* sql
      .withTransaction(sql`INSERT INTO child_fixture VALUES (99)`)
      .pipe(Effect.flip);
    // SQLITE_CONSTRAINT_FOREIGNKEY from COMMIT, not a later rollback or savepoint error.
    expect(
      (yield* Schema.decodeUnknownEffect(Schema.Struct({ errcode: Schema.Finite }))(
        failed.reason.cause,
      )).errcode,
    ).toBe(787);
    expect(yield* sql`SELECT COUNT(*) AS count FROM child_fixture`).toEqual([{ count: 0 }]);
    yield* sql.withTransaction(
      sql`INSERT INTO parent_fixture VALUES (99)`.pipe(
        Effect.andThen(sql`INSERT INTO child_fixture VALUES (99)`),
      ),
    );
    expect(yield* sql`SELECT COUNT(*) AS count FROM child_fixture`).toEqual([{ count: 1 }]);
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.live("waits out another connection's write lock while the event loop keeps running", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* fs.makeTempDirectoryScoped(), "agent.db");
    const database = yield* Layer.build(Database.layer(file));
    const sql = Context.get(database, SqlClient.SqlClient);
    yield* sql`CREATE TABLE lock_fixture(id INTEGER PRIMARY KEY)`;
    // Another connection, as the import worker's, holds the write lock.
    const other = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (other) => Effect.sync(() => other.close()),
    );
    other.exec("BEGIN IMMEDIATE");
    other.exec("INSERT INTO lock_fixture VALUES (1)");
    const statement = yield* Effect.forkChild(sql`INSERT INTO lock_fixture VALUES (2)`);
    const transaction = yield* Effect.forkChild(
      sql.withTransaction(sql`INSERT INTO lock_fixture VALUES (3)`),
    );

    // Waiting inside SQLite would hold this thread until its busy timeout, then fail.
    const before = yield* Clock.currentTimeMillis;
    yield* Effect.sleep("300 millis");
    expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(2_000);
    expect(statement.pollUnsafe()).toBeUndefined();
    expect(transaction.pollUnsafe()).toBeUndefined();

    other.exec("COMMIT");
    yield* Fiber.join(statement);
    yield* Fiber.join(transaction);
    expect(yield* sql`SELECT id FROM lock_fixture ORDER BY id`).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  }).pipe(Effect.scoped, provideFixture(NodeServices.layer)),
);

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
