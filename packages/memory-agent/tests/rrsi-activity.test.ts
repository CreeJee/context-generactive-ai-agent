import { it as effectTest } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { connectionContext, migrateDatabase } from "../src/db/database.ts";
import { readActivity as readOwnerActivity } from "../src/rrsi/activity.ts";

/** Activity of `db`, as the owner reads it through its SqlClient. */
const readActivity = (db: DatabaseSync) =>
  Effect.flatMap(connectionContext(db), (context) =>
    Effect.provideContext(readOwnerActivity, context),
  );

effectTest.effect(
  "archived projects do not block evaluation or advance idle time; restoration includes them again",
  () =>
    Effect.gen(function* () {
      const db = new DatabaseSync(":memory:");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          db.close();
        }),
      );

      migrateDatabase(db);
      for (const id of ["active", "archived"]) {
        db.prepare(
          "INSERT INTO projects (id,root,name,created_at,hidden_at) VALUES (?,?,?,?,?)",
        ).run(id, `/${id}`, id, "now", id === "archived" ? "now" : null);
        db.prepare("INSERT INTO sessions (id,project_id,created_at) VALUES (?,?,?)").run(
          id,
          id,
          "now",
        );
        db.prepare("INSERT INTO chat_threads VALUES (?, '[]', ?)").run(
          id,
          id === "archived" ? 9999 : 100,
        );
      }
      db.prepare(
        "INSERT INTO chat_runs (run_id,thread_id,status,started_at) VALUES ('run','archived','running',1)",
      ).run();
      db.prepare(
        "INSERT INTO queued_messages (id,session_id,seq,text,state,created_at,updated_at) VALUES ('queue','archived',1,'fixture','editing',1,1)",
      ).run();
      expect(yield* readActivity(db)).toEqual({ busy: 0, latest: 100 });
      db.prepare("UPDATE projects SET hidden_at=NULL WHERE id='archived'").run();
      expect(yield* readActivity(db)).toEqual({ busy: 2, latest: 9999 });
    }),
);

effectTest.effect("a running thread with missing ownership still protects user work", () =>
  Effect.gen(function* () {
    const db = new DatabaseSync(":memory:");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        db.close();
      }),
    );

    migrateDatabase(db);
    db.prepare(
      "INSERT INTO chat_runs (run_id,thread_id,status,started_at) VALUES ('run','unknown','running',1)",
    ).run();
    expect(yield* readActivity(db)).toEqual({ busy: 1, latest: null });
  }),
);
