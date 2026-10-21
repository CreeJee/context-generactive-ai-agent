import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { DatabaseSchemaRejectedReason, migrateDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";

const open = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

it.effect(
  "adopts the released schema cursor without replay and keeps migration metadata stable",
  () =>
    Effect.gen(function* () {
      const db = yield* open;
      for (const sql of migrations) db.exec(sql);
      db.exec(`PRAGMA user_version = ${migrations.length}`);
      migrateDatabase(db);
      const before = db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all();
      expect(before).toHaveLength(migrations.length);
      expect(before.map((row) => row.migration_id)).toEqual(
        migrations.map((_, index) => index + 1),
      );
      migrateDatabase(db);
      expect(db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all()).toEqual(
        before,
      );
    }),
);

it.effect("rejects missing metadata without repairing it or changing the released cursor", () =>
  Effect.gen(function* () {
    const db = yield* open;
    migrateDatabase(db);
    db.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 1");
    expect(() => migrateDatabase(db)).toThrow(
      expect.objectContaining({
        reason: DatabaseSchemaRejectedReason.cases.MetadataMismatch.make({}),
      }),
    );
    expect(
      db.prepare("SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 1").get(),
    ).toBeUndefined();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
    expect(db.isTransaction).toBe(false);
  }),
);

it.effect("rolls back metadata creation together with a failed pending migration", () =>
  Effect.gen(function* () {
    const db = yield* open;
    // A conflicting pre-existing table causes the first historical migration to fail.
    db.exec("CREATE TABLE projects (conflict TEXT); PRAGMA foreign_keys = ON");
    expect(() => migrateDatabase(db)).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
    ).toBeUndefined();
    expect(db.isTransaction).toBe(false);
  }),
);
