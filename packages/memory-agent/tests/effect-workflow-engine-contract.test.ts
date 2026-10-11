import { DatabaseSync } from "node:sqlite";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { Workflow, WorkflowEngine } from "effect/workflow";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { effectDatabaseSyncLayer } from "./support/effect-database-sync.ts";

const ContractWorkflow = Workflow.make("MemoryAgentEngineContract", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => value,
});

const withEngine = <A, E, R>(
  db: Database["Service"],
  program: Effect.Effect<A, E, R | WorkflowEngine.WorkflowEngine>,
) => {
  const singleRunner = SingleRunner.layer({ runnerStorage: "memory" }).pipe(
    Layer.provide([effectDatabaseSyncLayer(db.sqlite), NodeCrypto.layer]),
  );
  const engine = ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(singleRunner));
  return Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(engine);
      return yield* Effect.provideContext(program, services);
    }),
  );
};

const withDatabase = <A, E, R>(use: (db: Database["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-engine-contract-" });
      const services = yield* Layer.build(Database.layer(path.join(directory, "owner.db")));
      return yield* Effect.provideContext(Effect.flatMap(Database, use), services);
    }),
  ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

describe("Effect built-in workflow engine contract", () => {
  it.live("shares the owner connection and replays an execution id after engine restart", () =>
    withDatabase((db) => {
      let executions = 0;
      const register = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        yield* engine.register(ContractWorkflow, ({ value }) =>
          Effect.sync(() => {
            executions += 1;
            return `done:${value}`;
          }),
        );
        return engine;
      });
      return Effect.gen(function* () {
        const first = yield* withEngine(
          db,
          Effect.flatMap(register, (engine) =>
            engine.execute(ContractWorkflow, {
              executionId: "session/run/goal/revision",
              payload: { value: "same" },
            }),
          ),
        );
        const duplicate = yield* withEngine(
          db,
          Effect.flatMap(register, (engine) =>
            engine.execute(ContractWorkflow, {
              executionId: "session/run/goal/revision",
              payload: { value: "same" },
            }),
          ),
        );
        expect({ first, duplicate, executions }).toEqual({
          first: "done:same",
          duplicate: "done:same",
          executions: 1,
        });
        const tables = db.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster_%'")
          .all()
          .map(({ name }) => name)
          .sort((left, right) => String(left).localeCompare(String(right)));
        expect(tables).toEqual(["cluster_messages", "cluster_migrations", "cluster_replies"]);
      });
    }),
  );

  it.live("adds removable cluster tables after the 0.0.13 release schema", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-engine-release-" });
        const file = path.join(directory, "owner.db");
        const release = new DatabaseSync(file);
        try {
          for (const migration of migrations.slice(0, 30)) release.exec(migration);
          release.exec("PRAGMA user_version = 30");
          release
            .prepare("INSERT INTO projects (id, root, name, created_at) VALUES (?, ?, ?, ?)")
            .run("release-project", "/release", "release", "2026-10-10T00:00:00.000Z");
        } finally {
          release.close();
        }
        const services = yield* Layer.build(Database.layer(file));
        yield* Effect.provideContext(
          Effect.gen(function* () {
            const db = yield* Database;
            yield* withEngine(
              db,
              Effect.flatMap(WorkflowEngine.WorkflowEngine, (engine) =>
                engine.register(ContractWorkflow, ({ value }) => Effect.succeed(value)),
              ),
            );
            expect(
              db.sqlite.prepare("SELECT id, name FROM projects WHERE id = 'release-project'").get(),
            ).toEqual({ id: "release-project", name: "release" });
            db.sqlite.exec(`
              DROP TABLE cluster_replies;
              DROP TABLE cluster_messages;
              DROP TABLE cluster_migrations;
            `);
          }),
          services,
        );
        const reopened = yield* Layer.build(Database.layer(file));
        const project = yield* Effect.provideContext(
          Effect.map(Database, (db) =>
            db.sqlite.prepare("SELECT id, name FROM projects WHERE id = 'release-project'").get(),
          ),
          reopened,
        );
        expect(project).toEqual({ id: "release-project", name: "release" });
      }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
    ),
  );

  it.live("cannot atomically compose its SQL transaction with owner admission", () =>
    withDatabase((db) =>
      Effect.scoped(
        Effect.gen(function* () {
          db.sqlite.exec(`
            CREATE TABLE owner_admission_probe (id TEXT PRIMARY KEY);
            CREATE TABLE engine_request_probe (id TEXT PRIMARY KEY);
          `);
          const services = yield* Layer.build(effectDatabaseSyncLayer(db.sqlite));
          const exit = yield* Effect.provideContext(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return db.atomic(() => {
                db.sqlite.prepare("INSERT INTO owner_admission_probe VALUES (?)").run("bound-run");
                return Effect.runSyncExit(
                  sql.withTransaction(sql`INSERT INTO engine_request_probe VALUES ('request')`),
                );
              });
            }),
            services,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(db.sqlite.prepare("SELECT id FROM owner_admission_probe").all()).toEqual([
            { id: "bound-run" },
          ]);
          expect(db.sqlite.prepare("SELECT id FROM engine_request_probe").all()).toEqual([]);
        }),
      ),
    ),
  );
});
