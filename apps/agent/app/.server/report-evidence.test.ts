import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Database } from "memory-agent";
import { reportBundleResponse } from "./report-evidence";

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

const json = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new Cause.UnknownError(cause),
  });

describe("report evidence bundle route", () => {
  it.layer(fixture)((it) => {
    it.effect("rejects missing and mismatched identifiers before collecting anything", () =>
      Effect.gen(function* () {
        const never = () => Effect.die("should not collect");
        expect(
          (yield* reportBundleResponse(new Request("http://localhost/api/reports/evidence"), never))
            .status,
        ).toBe(400);
        for (const query of [
          "project=p2&session=s1",
          "project=p1&session=s2",
          "project=p1&session=missing",
        ]) {
          const denied = yield* reportBundleResponse(
            new Request(`http://localhost/api/reports/evidence?${query}`),
            never,
          );
          expect(denied.status).toBe(404);
          expect(yield* json(denied)).toEqual({ error: "session_not_found" });
        }
        const collected: string[] = [];
        const allowed = yield* reportBundleResponse(
          new Request("http://localhost/api/reports/evidence?project=p1&session=s1"),
          // The bundle itself is collected by memory-agent and tested there.
          (session) =>
            Effect.sync(() => collected.push(`${session.projectId}/${session.id}`)).pipe(
              Effect.andThen(Effect.die("bundle not under test")),
            ),
        ).pipe(Effect.exit);
        expect(collected).toEqual(["p1/s1"]);
        expect(Exit.isFailure(allowed)).toBe(true);
      }),
    );
  });
});
