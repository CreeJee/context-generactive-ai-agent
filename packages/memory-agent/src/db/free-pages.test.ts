import { NodeServices } from "@effect/platform-node";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "./database.ts";
import { reclaimFreePages } from "./free-pages.ts";

const pragma = (sql: SqlClient.SqlClient, name: "auto_vacuum" | "freelist_count") =>
  Effect.map(sql`SELECT * FROM ${sql.literal(`pragma_${name}`)}`.values, (rows) =>
    Number(rows[0]?.[0]),
  );

/** The temporary folder and the database layer need the platform's file system and paths. */
const withNodeServices = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
      Effect.provideContext(program, context),
    ),
  );

const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped(), "agent.db");
});

it.live("a new database returns the pages a deletion freed, keeping a few for later writes", () =>
  Effect.gen(function* () {
    const file = yield* databaseFile;
    const sql = Context.get(yield* Layer.build(Database.layer(file)), SqlClient.SqlClient);
    expect(yield* pragma(sql, "auto_vacuum")).toBe(2);
    yield* sql`CREATE TABLE free_pages_fixture(body BLOB)`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
      INSERT INTO free_pages_fixture SELECT randomblob(3000) FROM n`;
    yield* sql`DELETE FROM free_pages_fixture`;
    expect(yield* pragma(sql, "freelist_count")).toBeGreaterThan(3000);

    yield* Effect.provideService(reclaimFreePages(), SqlClient.SqlClient, sql);

    expect(yield* pragma(sql, "freelist_count")).toBeLessThan(1024);
  }).pipe(withNodeServices),
);

it.live("a database made before keeps its mode, and its free pages stay for later writes", () =>
  Effect.gen(function* () {
    const file = yield* databaseFile;
    yield* Effect.acquireUseRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (old) => Effect.sync(() => old.exec("CREATE TABLE made_before(id INTEGER PRIMARY KEY)")),
      (old) => Effect.sync(() => old.close()),
    );
    const sql = Context.get(yield* Layer.build(Database.layer(file)), SqlClient.SqlClient);
    expect(yield* pragma(sql, "auto_vacuum")).toBe(0);
  }).pipe(withNodeServices),
);
