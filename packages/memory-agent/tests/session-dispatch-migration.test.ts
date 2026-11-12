import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";

const tempFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "dispatches-" }), "owner.db");
}).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

describe("session dispatches table", () => {
  it.effect("the last migration step creates it additively", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* tempFile;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(file)),
          (sqlite) =>
            Effect.sync(() => {
              // The whole array, as a fresh app applies it. The step count is the schema version.
              migrations.forEach((step) => sqlite.exec(step));
              sqlite.exec(`PRAGMA user_version = ${migrations.length}`);
              sqlite.exec(
                "INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01')",
              );
              sqlite.exec(
                "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('from', 'p', 'from', '2026-01-01'), ('to', 'p', 'to', '2026-01-01')",
              );
              sqlite.exec(
                "INSERT INTO session_dispatches (id, project_id, from_session_id, from_run_id, to_session_id, body, state, created_at) VALUES ('d1', 'p', 'from', 'run-1', 'to', 'hello', 'waiting', '2026-01-01')",
              );
              expect(
                sqlite
                  .prepare(
                    "SELECT state, delivered_run_id, delivered_at FROM session_dispatches WHERE id = 'd1'",
                  )
                  .get(),
              ).toEqual({ state: "waiting", delivered_run_id: null, delivered_at: null });
              // Delivering writes both fields at once; a delivered row without them is refused.
              expect(() =>
                sqlite.exec("UPDATE session_dispatches SET state = 'delivered' WHERE id = 'd1'"),
              ).toThrow();
              sqlite.exec(
                "UPDATE session_dispatches SET state = 'delivered', delivered_run_id = 'run-2', delivered_at = '2026-01-02' WHERE id = 'd1'",
              );
              // Self dispatch is refused by the table, so a rejected call cannot write one.
              expect(() =>
                sqlite.exec(
                  "INSERT INTO session_dispatches (id, project_id, from_session_id, from_run_id, to_session_id, body, state, created_at) VALUES ('d2', 'p', 'from', 'run-1', 'from', 'hello', 'waiting', '2026-01-01')",
                ),
              ).toThrow();
            }),
          (sqlite) => Effect.sync(() => sqlite.close()),
        );
      }),
    ),
  );

  it.effect("a build that knows one step fewer reads a file without the table", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* tempFile;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(file)),
          (sqlite) =>
            Effect.sync(() => {
              // An app from before the dispatch table applied every step but the last one.
              migrations.slice(0, -1).forEach((step) => sqlite.exec(step));
              sqlite.exec(`PRAGMA user_version = ${migrations.length - 1}`);
              // The step before the last one leaves no dispatch table behind.
              expect(
                sqlite
                  .prepare(
                    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'session_dispatches'",
                  )
                  .get(),
              ).toEqual({ n: 0 });
            }),
          (sqlite) => Effect.sync(() => sqlite.close()),
        );
      }),
    ),
  );
});
