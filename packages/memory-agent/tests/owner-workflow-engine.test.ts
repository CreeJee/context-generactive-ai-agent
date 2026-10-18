import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Activity, Workflow, WorkflowEngine } from "effect/workflow";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { ownerWorkflowEngineLayer } from "../src/workflow/owner-workflow-engine.ts";
import { OwnerWorkflowAdmission } from "../src/workflow/owner-workflow-storage.ts";

const ContractWorkflow = Workflow.make("OwnerWorkflowEngineContract", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => value,
});

class ActivityInput extends Context.Service<ActivityInput, { readonly value: string }>()(
  "memory-agent/tests/owner-workflow-engine.test/ActivityInput",
) {}
class ActivityRefused extends Schema.TaggedError<ActivityRefused>()("ActivityRefused", {
  reason: Schema.Literal("refused"),
  value: Schema.String,
}) {}

const withDatabase = <A, E, R>(use: (database: Database["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owner-workflow-engine-" });
      const context = yield* Layer.build(Database.layer(path.join(directory, "owner.db")));
      return yield* Effect.provideContext(Effect.flatMap(Database, use), context);
    }),
  ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

/** A fresh engine scope over the database `withDatabase` provides. */
const withEngine = <A, E, R>(
  use: Effect.Effect<A, E, R | WorkflowEngine.WorkflowEngine | OwnerWorkflowAdmission>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(ownerWorkflowEngineLayer);
      return yield* Effect.provideContext(use, context);
    }),
  );

describe("owner workflow engine", () => {
  it.live("preserves activity services and typed failures across durable replay", () =>
    withDatabase(() => {
      let executions = 0;
      const workflow = Workflow.make("OwnerActivityFailure", {
        payload: { value: Schema.String },
        error: ActivityRefused,
        idempotencyKey: ({ value }) => value,
      });
      const run = withEngine(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          yield* engine.register(workflow, () =>
            Activity.make({
              name: "refuse",
              error: ActivityRefused,
              execute: Effect.gen(function* () {
                const input = yield* ActivityInput;
                executions++;
                return yield* ActivityRefused.make({ reason: "refused", value: input.value });
              }),
            }),
          );
          return yield* engine
            .execute(workflow, {
              executionId: "typed-activity-failure",
              payload: { value: "same" },
            })
            .pipe(Effect.flip);
        }).pipe(Effect.provideService(ActivityInput, { value: "captured service" })),
      );
      return Effect.gen(function* () {
        const first = yield* run;
        const replayed = yield* run;
        expect(first).toMatchObject({
          _tag: "ActivityRefused",
          reason: "refused",
          value: "captured service",
        });
        expect(replayed).toEqual(first);
        expect(executions).toBe(1);
      });
    }),
  );

  it.live("persists a transformed Activity result once and decodes the typed workflow result", () =>
    withDatabase(() => {
      const workflow = Workflow.make("OwnerWorkflowTransformedActivity", {
        payload: { value: Schema.String },
        success: Schema.Finite,
        idempotencyKey: ({ value }) => value,
      });
      const run = withEngine(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          yield* engine.register(workflow, () =>
            Activity.make({
              name: "transformed-number",
              success: Schema.FiniteFromString,
              execute: Effect.succeed(42),
            }),
          );
          return yield* engine.execute(workflow, {
            executionId: "transformed-activity-execution",
            payload: { value: "same" },
          });
        }),
      );
      return Effect.gen(function* () {
        expect(yield* run).toBe(42);
        expect(yield* run).toBe(42);
      });
    }),
  );

  it.live("replays a completed Activity after the scoped engine restarts", () =>
    withDatabase(() => {
      let executions = 0;
      const run = withEngine(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          yield* engine.register(ContractWorkflow, ({ value }) =>
            Activity.make({
              name: "OwnerWorkflowEngineContract.activity",
              success: Schema.String,
              execute: Effect.sync(() => {
                executions += 1;
                return `done:${value}`;
              }),
            }),
          );
          return yield* engine.execute(ContractWorkflow, {
            executionId: "session/run/goal/revision",
            payload: { value: "same" },
          });
        }),
      );
      return Effect.gen(function* () {
        const first = yield* run;
        const replayed = yield* run;
        expect({ first, replayed, executions }).toEqual({
          first: "done:same",
          replayed: "done:same",
          executions: 1,
        });
      });
    }),
  );

  it.live("commits owner binding and the first request in one transaction", () =>
    withDatabase((database) =>
      withEngine(
        Effect.gen(function* () {
          database.sqlite.exec("CREATE TABLE owner_workflow_binding_probe (id TEXT PRIMARY KEY)");
          const admission = yield* OwnerWorkflowAdmission;
          const request = {
            workflowName: ContractWorkflow._tag,
            executionId: "atomic-execution",
            payload: { value: "bound" },
          };

          const failed = yield* admission
            .admit(
              request,
              Effect.sync(() =>
                database.sqlite
                  .prepare("INSERT INTO owner_workflow_binding_probe VALUES (?)")
                  .run("rolled-back"),
              ).pipe(Effect.andThen(Effect.fail("reject binding" as const))),
            )
            .pipe(Effect.flip);
          expect(failed).toBe("reject binding");
          expect(
            database.sqlite.prepare("SELECT id FROM owner_workflow_binding_probe").all(),
          ).toEqual([]);
          expect(
            database.sqlite.prepare("SELECT execution_id FROM owner_workflow_executions").all(),
          ).toEqual([]);

          yield* admission.admit(
            request,
            Effect.sync(() =>
              database.sqlite
                .prepare("INSERT INTO owner_workflow_binding_probe VALUES (?)")
                .run("committed"),
            ),
          );
          expect(
            database.sqlite.prepare("SELECT id FROM owner_workflow_binding_probe").all(),
          ).toEqual([{ id: "committed" }]);
          expect(
            database.sqlite
              .prepare("SELECT execution_id, workflow_name FROM owner_workflow_executions")
              .all(),
          ).toEqual([
            {
              execution_id: "atomic-execution",
              workflow_name: ContractWorkflow._tag,
            },
          ]);

          let rebound = false;
          const duplicate = yield* admission.admit(
            request,
            Effect.sync(() => {
              rebound = true;
            }),
          );
          expect(duplicate.type).toBe("existing");
          expect(rebound).toBe(false);
        }),
      ),
    ),
  );

  it.live("interrupts live workflow fibers when the engine scope closes", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        let finalized = 0;
        yield* withEngine(
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            yield* engine.register(ContractWorkflow, () =>
              Effect.never.pipe(Effect.ensuring(Effect.sync(() => finalized++))),
            );
            yield* engine.execute(ContractWorkflow, {
              executionId: "scope-owned-execution",
              payload: { value: "pending" },
              discard: true,
            });
          }),
        );
        expect(finalized).toBe(1);
      }),
    ),
  );
});
