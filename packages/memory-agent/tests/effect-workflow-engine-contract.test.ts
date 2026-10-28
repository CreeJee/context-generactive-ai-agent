import { DatabaseSync } from "node:sqlite";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { Workflow, WorkflowEngine } from "effect/workflow";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { sqlGet, sqlExec } from "./support/sql.ts";

const ContractWorkflow = Workflow.make("MemoryAgentEngineContract", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => value,
});

/** A cluster engine over the app's `SqlClient`, as the 0.0.13 release ran it. */
const withEngine = <A, E, R>(
  program: Effect.Effect<A, E, R | SqlClient.SqlClient | WorkflowEngine.WorkflowEngine>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Effect.context<SqlClient.SqlClient>();
      const singleRunner = SingleRunner.layer({ runnerStorage: "memory" }).pipe(
        Layer.provide([Layer.succeedContext(database), NodeCrypto.layer]),
      );
      const services = yield* Layer.build(
        ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(singleRunner)),
      );
      return yield* Effect.provideContext(program, Context.merge(database, services));
    }),
  );

describe("Effect built-in workflow engine contract", () => {
  it.live("adds removable cluster tables after the 0.0.13 release schema", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-engine-release-" });
        const file = path.join(directory, "owner.db");
        const release = new DatabaseSync(file);
        try {
          migrations.slice(0, 30).forEach((migration) => release.exec(migration));
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
            yield* withEngine(
              Effect.flatMap(WorkflowEngine.WorkflowEngine, (engine) =>
                engine.register(ContractWorkflow, ({ value }) => Effect.succeed(value)),
              ),
            );
            expect(
              yield* sqlGet("SELECT id, name FROM projects WHERE id = 'release-project'"),
            ).toEqual({ id: "release-project", name: "release" });
            yield* sqlExec(`
              DROP TABLE cluster_replies;
              DROP TABLE cluster_messages;
              DROP TABLE cluster_migrations;
            `);
          }),
          services,
        );
        const reopened = yield* Layer.build(Database.layer(file));
        const project = yield* Effect.provideContext(
          sqlGet("SELECT id, name FROM projects WHERE id = 'release-project'"),
          reopened,
        );
        expect(project).toEqual({ id: "release-project", name: "release" });
      }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
    ),
  );
});
