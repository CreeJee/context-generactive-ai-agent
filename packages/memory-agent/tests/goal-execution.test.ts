import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, MutableRef, Path } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { ExecutionAdmission } from "../src/runtime/execution-admission.ts";
import {
  GoalExecutionErrorReason,
  GoalExecutionPayload,
  GoalExecutionSuccess,
} from "../src/workflow/goal-execution-contracts.ts";
import { Admission } from "../src/workflow/run-bindings.ts";
import { workflowName } from "../src/workflow/owner-workflow-engine.ts";
import { OwnerWorkflowAdmissionResult } from "../src/workflow/owner-workflow-storage.ts";
import {
  GoalExecution,
  GoalExecutionAdmissionRefused,
  GoalExecutions,
  goalExecutionLayer,
} from "../src/workflow/goal-execution.ts";
import { sqlAll, sqlGet, sqlRun, sqlExec } from "./support/sql.ts";

const payload = GoalExecutionPayload.make({
  identity: {
    owner: { ownerId: "project-1", generation: "generation-1" },
    sessionId: "session-1",
    runId: "run-1",
    goalInstanceId: "goal-1",
    workflowRevisionId: 7,
  },
});

const binding = {
  runId: "run-1",
  sessionId: "session-1",
  goalInstanceId: "goal-1",
  goalVersion: 3,
  planVersion: 2,
  workflowRevisionId: 7,
} as const;

const withGoalExecutions = <A, E, R>(
  use: () => Effect.Effect<A, E, R | GoalExecutions | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-execution-" });
      const databaseContext = yield* Layer.build(Database.layer(path.join(directory, "owner.db")));
      return yield* Effect.provideContext(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            goalExecutionLayer.pipe(
              Layer.provide(Layer.succeedContext(databaseContext)),
              Layer.provide(ExecutionAdmission.layer()),
            ),
          );
          return yield* Effect.provideContext(use(), Context.merge(databaseContext, context));
        }),
        databaseContext,
      );
    }),
  ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

describe("GoalExecution workflow", () => {
  it.live("atomically admits, suspends, completes and replays without rerunning binding", () =>
    withGoalExecutions(() =>
      Effect.gen(function* () {
        const goals = yield* GoalExecutions;
        const binds = MutableRef.make(0);
        const admitted = yield* goals.admitAndStart(
          payload,
          Effect.sync((): Admission => {
            MutableRef.increment(binds);
            return Admission.bound({ binding });
          }),
        );
        expect(admitted).toEqual(OwnerWorkflowAdmissionResult.admitted({ value: binding }));

        const executionId = yield* GoalExecution.executionId(payload);
        expect(
          yield* sqlGet(
            "SELECT execution_id, workflow_name FROM owner_workflow_executions WHERE execution_id = ?",
            executionId,
          ),
        ).toEqual({ execution_id: executionId, workflow_name: workflowName(GoalExecution) });

        yield* goals.succeed(payload);
        const first = yield* GoalExecution.execute(payload);
        const replayed = yield* GoalExecution.execute(payload);
        expect(first).toEqual(replayed);
        expect(first).toEqual(
          GoalExecutionSuccess.make({
            executionId,
            runId: payload.identity.runId,
            outcome: "completed",
          }),
        );
        expect(MutableRef.get(binds)).toBe(1);
      }),
    ),
  );

  it.live(
    "rejects owner ID and generation changes without rebinding or creating another execution",
    () =>
      withGoalExecutions(() =>
        Effect.gen(function* () {
          const goals = yield* GoalExecutions;
          const binds = MutableRef.make(0);
          const bind = Effect.sync((): Admission => {
            MutableRef.increment(binds);
            return Admission.bound({ binding });
          });
          yield* goals.admitAndStart(payload, bind);
          yield* Effect.forEach(
            [
              { ownerId: "project-2", generation: "generation-1" },
              { ownerId: "project-1", generation: "generation-2" },
            ],
            Effect.fnUntraced(function* (owner) {
              const changedOwner: GoalExecutionPayload = {
                ...payload,
                identity: { ...payload.identity, owner },
              };
              const failure = yield* goals.admitAndStart(changedOwner, bind).pipe(Effect.flip);
              expect(failure).toEqual(
                GoalExecutionAdmissionRefused.make({ reason: "owner_mismatch" }),
              );
            }),
            { discard: true },
          );
          expect(MutableRef.get(binds)).toBe(1);
          expect(yield* sqlGet("SELECT count(*) AS n FROM owner_workflow_executions")).toEqual({
            n: 1,
          });
        }),
      ),
  );

  it.live("persists a failed durable completion before returning", () =>
    withGoalExecutions(() =>
      Effect.gen(function* () {
        const goals = yield* GoalExecutions;
        yield* goals.admitAndStart(
          payload,
          Effect.succeed<Admission>(Admission.bound({ binding })),
        );
        yield* goals.fail(
          payload,
          GoalExecutionErrorReason.cases.SideEffectUncertain.make({
            operationId: "1",
            state: "uncertain",
          }),
        );
        expect(yield* sqlGet("SELECT status FROM owner_workflow_executions")).toEqual({
          status: "completed",
        });
      }),
    ),
  );

  it.live("rolls back both binding work and durable request when owner binding refuses", () =>
    withGoalExecutions(() =>
      Effect.gen(function* () {
        yield* sqlExec("CREATE TABLE goal_execution_binding_probe (id TEXT PRIMARY KEY)");
        const sql = yield* SqlClient.SqlClient;
        const goals = yield* GoalExecutions;
        const failure = yield* goals
          .admitAndStart(
            payload,
            sqlRun("INSERT INTO goal_execution_binding_probe VALUES (?)", "rolled-back").pipe(
              Effect.as<Admission>(Admission.refused({ reason: "workflow_changed" })),
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.orDie,
            ),
          )
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(GoalExecutionAdmissionRefused);
        expect(yield* sqlAll("SELECT id FROM goal_execution_binding_probe")).toEqual([]);
        expect(yield* sqlAll("SELECT execution_id FROM owner_workflow_executions")).toEqual([]);
      }),
    ),
  );
});
