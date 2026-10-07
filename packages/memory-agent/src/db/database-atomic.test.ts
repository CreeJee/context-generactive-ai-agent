import { Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "./database.ts";

class AtomicFixtureFailed extends Schema.TaggedError<AtomicFixtureFailed>()(
  "AtomicFixtureFailed",
  {},
) {}

it.effect(
  "rolls back a nested callback without retaining its savepoint or discarding outer work",
  () =>
    Effect.gen(function* () {
      const db = yield* Database;
      yield* Effect.try(() => {
        db.sqlite.exec("CREATE TABLE atomic_nested_fixture(id INTEGER PRIMARY KEY)");
        db.atomic(() => {
          db.sqlite.prepare("INSERT INTO atomic_nested_fixture VALUES(?)").run(1);
          expect(() =>
            db.atomic(() => {
              db.sqlite.prepare("INSERT INTO atomic_nested_fixture VALUES(?)").run(2);
              throw AtomicFixtureFailed.make({});
            }),
          ).toThrow(AtomicFixtureFailed);
          // The failed nested transaction must release, not leave an orphaned savepoint.
          expect(() => db.sqlite.exec("RELEASE atomic_1")).toThrow();
          db.atomic(() => db.sqlite.prepare("INSERT INTO atomic_nested_fixture VALUES(?)").run(3));
        });
      });
      expect(
        yield* Effect.try(() =>
          db.sqlite.prepare("SELECT id FROM atomic_nested_fixture ORDER BY id").all(),
        ),
      ).toEqual([{ id: 1 }, { id: 3 }]);
    }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("preserves a deferred COMMIT failure, rolls back and permits the next transaction", () =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* Effect.try(() =>
      db.sqlite.exec(`
    CREATE TABLE atomic_parent_fixture(id INTEGER PRIMARY KEY);
    CREATE TABLE atomic_child_fixture(parent_id INTEGER REFERENCES atomic_parent_fixture(id) DEFERRABLE INITIALLY DEFERRED);
  `),
    );
    const failed = yield* Effect.try(() =>
      db.atomic(() => {
        db.sqlite.prepare("INSERT INTO atomic_child_fixture VALUES(?)").run(99);
      }),
    ).pipe(Effect.flip);
    const driverFailure = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ errcode: Schema.Finite }),
    )(failed.cause);
    // SQLITE_CONSTRAINT_FOREIGNKEY: preserve the failed COMMIT, not a missing-savepoint error.
    expect(driverFailure.errcode).toBe(787);
    expect(
      yield* Effect.try(() =>
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM atomic_child_fixture").get(),
      ),
    ).toEqual({ count: 0 });
    yield* Effect.try(() =>
      db.atomic(() => {
        db.sqlite.prepare("INSERT INTO atomic_parent_fixture VALUES(?)").run(99);
        db.sqlite.prepare("INSERT INTO atomic_child_fixture VALUES(?)").run(99);
      }),
    );
    expect(
      yield* Effect.try(() =>
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM atomic_child_fixture").get(),
      ),
    ).toEqual({ count: 1 });
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
