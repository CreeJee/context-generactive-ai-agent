import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "./database.ts";
import { refreshPlannerStatistics } from "./planner-statistics.ts";

/** The temporary folder and the database layer need the platform's file system and paths. */
const withNodeServices = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
      Effect.provideContext(program, context),
    ),
  );

it.live("statistics cover the app's tables but not the ones emptied by design", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* fs.makeTempDirectoryScoped(), "agent.db");
    const sql = Context.get(yield* Layer.build(Database.layer(file)), SqlClient.SqlClient);
    yield* sql`CREATE TABLE planner_fixture(group_id INTEGER NOT NULL)`;
    yield* sql`CREATE INDEX planner_fixture_group ON planner_fixture(group_id)`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
      INSERT INTO planner_fixture SELECT i % 10 FROM n`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
      INSERT INTO lexical_changes(node_seq) SELECT i FROM n`;

    yield* Effect.provideService(refreshPlannerStatistics("all"), SqlClient.SqlClient, sql);

    const analyzed = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ tbl: Schema.String }),
      execute: () => sql`SELECT DISTINCT tbl FROM sqlite_stat1`,
    })();
    const tables = analyzed.map((row) => row.tbl);
    expect(tables).toContain("planner_fixture");
    expect(tables).not.toContain("lexical_changes");
  }).pipe(withNodeServices),
);
