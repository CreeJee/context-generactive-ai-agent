import { Deferred, Effect, Fiber, Layer } from "effect";
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

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
