import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, MutableRef, Path, Schema, Tracer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import {
  ownerWorkflowEngineLayer,
  suspendedRetrySchedule,
  workflowName,
} from "../src/workflow/owner-workflow-engine.ts";
import {
  OwnerWorkflowAdmission,
  OwnerWorkflowAdmissionResult,
} from "../src/workflow/owner-workflow-storage.ts";
import { sqlAll, sqlRun, sqlExec } from "./support/sql.ts";

const ContractWorkflow = Workflow.make("OwnerWorkflowEngineContract", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => value,
});

class ActivityInput extends Context.Service<ActivityInput, { readonly value: string }>()(
  "memory-agent/tests/owner-workflow-engine.test/ActivityInput",
) {}
class ActivityRefused extends Schema.TaggedError<
  ActivityRefused,
  { readonly brand: unique symbol }
>()("ActivityRefused", {
  reason: Schema.Literal("refused"),
  value: Schema.String,
}) {}

const withDatabase = <A, E, R>(use: () => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owner-workflow-engine-" });
      const context = yield* Layer.build(Database.layer(path.join(directory, "owner.db")));
      return yield* Effect.provideContext(Effect.suspend(use), context);
    }),
  ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

/** A fresh engine scope over the database `withDatabase` provides. */
const withEngine = <A, E, R>(
  use: Effect.Effect<
    A,
    E,
    R | SqlClient.SqlClient | WorkflowEngine.WorkflowEngine | OwnerWorkflowAdmission
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(ownerWorkflowEngineLayer);
      const database = yield* Effect.context<SqlClient.SqlClient>();
      return yield* Effect.provideContext(use, Context.merge(database, context));
    }),
  );

/** Lets forked engine fibers run up to their next wait on the test clock. */
const settle = Effect.repeat(Effect.yieldNow, { times: 100 });

/** A workflow whose body counts its passes and then waits for its gate. */
const gated = (name: string) => {
  const workflow = Workflow.make(name, {
    payload: { value: Schema.String },
    idempotencyKey: ({ value }) => value,
    suspendedRetrySchedule,
  });
  const gate = DurableDeferred.make(`${name}/Gate`);
  const passes = MutableRef.make(0);
  const register = Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    yield* engine.register(workflow, () =>
      Effect.sync(() => MutableRef.increment(passes)).pipe(
        Effect.andThen(DurableDeferred.await(gate)),
      ),
    );
  });
  // `execute` hands the engine the workflow's retry schedule, as the app's callers do.
  const run = (value: string) => workflow.execute({ value });
  const start = (value: string) => workflow.execute({ value }, { discard: true });
  const open = Effect.fnUntraced(function* (value: string) {
    const executionId = yield* workflow.executionId({ value });
    yield* DurableDeferred.succeed(gate, {
      token: DurableDeferred.tokenFromExecutionId(gate, { workflow, executionId }),
      value: undefined,
    });
  });
  return { passes, register, run, start, open };
};

describe("owner workflow engine", () => {
  it.live("preserves activity services and typed failures across durable replay", () =>
    withDatabase(() => {
      const executions = MutableRef.make(0);
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
                MutableRef.increment(executions);
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
        expect(first).toBeInstanceOf(ActivityRefused);
        expect(first).toMatchObject({ reason: "refused", value: "captured service" });
        expect(replayed).toEqual(first);
        expect(MutableRef.get(executions)).toBe(1);
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
      const executions = MutableRef.make(0);
      const run = withEngine(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          yield* engine.register(ContractWorkflow, ({ value }) =>
            Activity.make({
              name: "OwnerWorkflowEngineContract.activity",
              success: Schema.String,
              execute: Effect.sync(() => {
                MutableRef.increment(executions);
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
        expect({ first, replayed, executions: MutableRef.get(executions) }).toEqual({
          first: "done:same",
          replayed: "done:same",
          executions: 1,
        });
      });
    }),
  );

  it.live("commits owner binding and the first request in one transaction", () =>
    withDatabase(() =>
      withEngine(
        Effect.gen(function* () {
          yield* sqlExec("CREATE TABLE owner_workflow_binding_probe (id TEXT PRIMARY KEY)");
          const sql = yield* SqlClient.SqlClient;
          const admission = yield* OwnerWorkflowAdmission;
          const request = {
            workflowName: workflowName(ContractWorkflow),
            executionId: "atomic-execution",
            payload: { value: "bound" },
          };

          const failed = yield* admission
            .admit(
              request,
              sqlRun("INSERT INTO owner_workflow_binding_probe VALUES (?)", "rolled-back").pipe(
                Effect.andThen(Effect.fail("reject binding" as const)),
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
            )
            .pipe(Effect.flip);
          expect(failed).toBe("reject binding");
          expect(yield* sqlAll("SELECT id FROM owner_workflow_binding_probe")).toEqual([]);
          expect(yield* sqlAll("SELECT execution_id FROM owner_workflow_executions")).toEqual([]);

          yield* admission.admit(
            request,
            sqlRun("INSERT INTO owner_workflow_binding_probe VALUES (?)", "committed").pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          );
          expect(yield* sqlAll("SELECT id FROM owner_workflow_binding_probe")).toEqual([
            { id: "committed" },
          ]);
          expect(
            yield* sqlAll("SELECT execution_id, workflow_name FROM owner_workflow_executions"),
          ).toEqual([
            {
              execution_id: "atomic-execution",
              workflow_name: workflowName(ContractWorkflow),
            },
          ]);

          const rebound = MutableRef.make(false);
          const duplicate = yield* admission.admit(
            request,
            Effect.sync(() => {
              MutableRef.set(rebound, true);
            }),
          );
          expect(OwnerWorkflowAdmissionResult.$is("existing")(duplicate)).toBe(true);
          expect(MutableRef.get(rebound)).toBe(false);
        }),
      ),
    ),
  );

  it.live("interrupts live workflow fibers when the engine scope closes", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const finalized = MutableRef.make(0);
        yield* withEngine(
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            yield* engine.register(ContractWorkflow, () =>
              Effect.never.pipe(
                Effect.ensuring(Effect.sync(() => MutableRef.increment(finalized))),
              ),
            );
            yield* engine.execute(ContractWorkflow, {
              executionId: "scope-owned-execution",
              payload: { value: "pending" },
              discard: true,
            });
          }),
        );
        expect(MutableRef.get(finalized)).toBe(1);
      }),
    ),
  );

  it.effect("stamps when an execution was admitted and when it last changed", () =>
    withDatabase(() =>
      withEngine(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          const workflow = Workflow.make("OwnerWorkflowTimes", {
            payload: { value: Schema.String },
            idempotencyKey: ({ value }) => value,
          });
          const gate = DurableDeferred.make("OwnerWorkflowTimes/Gate");
          yield* engine.register(workflow, () => DurableDeferred.await(gate));
          const reaches = (status: string) =>
            Effect.yieldNow.pipe(
              Effect.andThen(
                sqlAll("SELECT status, created_at, updated_at FROM owner_workflow_executions"),
              ),
              Effect.repeat({ until: (rows) => rows[0]?.status === status }),
            );
          yield* TestClock.setTime(1_000);
          yield* engine.execute(workflow, {
            executionId: "stamped-execution",
            payload: { value: "stamped" },
            discard: true,
          });
          yield* reaches("suspended");
          yield* TestClock.setTime(5_000);
          yield* DurableDeferred.succeed(gate, {
            token: DurableDeferred.tokenFromExecutionId(gate, {
              workflow,
              executionId: "stamped-execution",
            }),
            value: undefined,
          });
          expect(yield* reaches("completed")).toEqual([
            { status: "completed", created_at: 1_000, updated_at: 5_000 },
          ]);
        }),
      ),
    ),
  );

  it.effect("wakes a waiting caller as soon as its execution completes", () =>
    withDatabase(() =>
      withEngine(
        Effect.gen(function* () {
          const { register, run, open } = gated("OwnerWorkflowWake");
          yield* register;
          const caller = yield* Effect.forkChild(run("woken"));
          yield* settle;
          yield* open("woken");
          yield* settle;
          // The test clock never moved, so no retry schedule step woke the caller.
          expect(caller.pollUnsafe()?._tag).toBe("Success");
        }),
      ),
    ),
  );

  it.effect(
    "replays a waiting execution only at the steps of its retry schedule",
    () =>
      withDatabase(() =>
        withEngine(
          Effect.gen(function* () {
            const { passes, register, run } = gated("OwnerWorkflowReplays");
            yield* register;
            yield* Effect.forkChild(run("waiting"));
            yield* settle;
            yield* Effect.forEach(
              Array.from({ length: 600 }),
              () => Effect.andThen(TestClock.adjust("1 second"), settle),
              { discard: true },
            );
            // The first pass, then one per step: 1, 2, 4 … 256 seconds end by 511s; the next is 300s later.
            expect(MutableRef.get(passes)).toBe(10);
          }),
        ),
      ),
    // Ten minutes in one-second steps, each letting the woken caller wait again.
    { timeout: 30_000 },
  );

  it.effect("drops a completed execution from memory", () =>
    withDatabase(() =>
      withEngine(
        Effect.gen(function* () {
          const { register, start, open } = gated("OwnerWorkflowDrops");
          yield* register;
          yield* start("first");
          yield* settle;
          yield* open("first");
          yield* settle;
          const spans: Array<Tracer.NativeSpan> = [];
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          });
          yield* start("second").pipe(Effect.withTracer(tracer));
          const resumed = spans.find((span) => span.name === "OwnerWorkflowEngine.resumeExecution");
          expect(resumed?.attributes.get("executions")).toBe(0);
        }),
      ),
    ),
  );

  it.effect("stores a result its codec cannot encode as a defect and does not run it again", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const workflow = Workflow.make("OwnerWorkflowUnencodable", {
          payload: { value: Schema.String },
          success: Schema.Finite,
          idempotencyKey: ({ value }) => value,
        });
        const passes = MutableRef.make(0);
        const run = withEngine(
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            yield* engine.register(workflow, () =>
              Effect.sync(() => {
                MutableRef.increment(passes);
                return Number.NaN;
              }),
            );
            return yield* engine
              .execute(workflow, { executionId: "unencodable", payload: { value: "nan" } })
              .pipe(Effect.exit);
          }),
        );
        const first = yield* run;
        const replayed = yield* run;
        expect(Exit.hasDies(first)).toBe(true);
        expect(Exit.hasDies(replayed)).toBe(true);
        expect(MutableRef.get(passes)).toBe(1);
        expect(yield* sqlAll("SELECT status FROM owner_workflow_executions")).toEqual([
          { status: "completed" },
        ]);
      }),
    ),
  );
});
