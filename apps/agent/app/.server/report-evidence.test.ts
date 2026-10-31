import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { Database } from "memory-agent";
import { reportSession } from "./report-evidence";

const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE sessions(id TEXT, project_id TEXT, title TEXT);
      INSERT INTO sessions VALUES ('s1', 'p1', 'bad approval');
      INSERT INTO sessions VALUES ('s2', 'p2', 'other project');
    `).unprepared;
  }),
).pipe(
  Layer.provideMerge(
    Database.over(
      Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (db) => Effect.sync(() => db.close()),
      ),
    ),
  ),
);

describe("report evidence session", () => {
  it.layer(fixture)((it) => {
    it.effect("finds a session only under its own project", () =>
      Effect.gen(function* () {
        const denied = yield* Effect.forEach(
          [
            ["p2", "s1"],
            ["p1", "s2"],
            ["p1", "missing"],
          ] as const,
          ([project, session]) => reportSession(project, session),
        );
        expect(denied.every(Option.isNone)).toBe(true);
        expect(Option.getOrNull(yield* reportSession("p1", "s1"))).toEqual({
          id: "s1",
          projectId: "p1",
          title: "bad approval",
        });
      }),
    );
  });
});
