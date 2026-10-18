import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { ExecutionAdmission } from "../src/runtime/execution-admission.ts";
import type { GoalExecutionPayload } from "../src/workflow/goal-execution-contracts.ts";
import type { Admission } from "../src/workflow/run-bindings.ts";
import {
  GoalExecution,
  GoalExecutionAdmissionRefused,
  GoalExecutions,
  goalExecutionLayer,
} from "../src/workflow/goal-execution.ts";

const payload: GoalExecutionPayload = {
  _tag: "GoalExecutionPayload",
  identity: {
    owner: { ownerId: "project-1", generation: "generation-1" },
    sessionId: "session-1",
    runId: "run-1",
    goalInstanceId: "goal-1",
    workflowRevisionId: 7,
  },
};

const binding = {
  runId: "run-1",
  sessionId: "session-1",
  goalInstanceId: "goal-1",
  goalVersion: 3,
  planVersion: 2,
  workflowRevisionId: 7,
} as const;

const withGoalExecutions = <A, E, R>(
  use: (database: Database["Service"]) => Effect.Effect<A, E, R | GoalExecutions>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-execution-" });
      const databaseContext = yield* Layer.build(Database.layer(path.join(directory, "owner.db")));
      return yield* Effect.provideContext(
        Effect.gen(function* () {
          const database = yield* Database;
          const context = yield* Layer.build(
            goalExecutionLayer.pipe(
              Layer.provide(Layer.succeedContext(databaseContext)),
              Layer.provide(ExecutionAdmission.layer()),
            ),
          );
          return yield* Effect.provideContext(use(database), context);
        }),
        databaseContext,
      );
    }),
  ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

describe("GoalExecution workflow", () => {
  it.live("atomically admits, suspends, completes and replays without rerunning binding", () =>
    withGoalExecutions((database) =>
      Effect.gen(function* () {
        const goals = yield* GoalExecutions;
        let binds = 0;
        const admitted = yield* goals.admitAndStart(
          payload,
          Effect.sync((): Admission => {
            binds += 1;
            return { status: "bound", binding };
          }),
        );
        expect(admitted).toEqual({ type: "admitted", value: binding });

        const executionId = yield* GoalExecution.executionId(payload);
        expect(
          database.sqlite
            .prepare(
              "SELECT execution_id, workflow_name FROM owner_workflow_executions WHERE execution_id = ?",
            )
            .get(executionId),
        ).toEqual({ execution_id: executionId, workflow_name: GoalExecution._tag });

        yield* goals.succeed(payload);
        const first = yield* GoalExecution.execute(payload);
        const replayed = yield* GoalExecution.execute(payload);
        expect(first).toEqual(replayed);
        expect(first).toEqual({
          _tag: "GoalExecutionSuccess",
          executionId,
          runId: payload.identity.runId,
          outcome: "completed",
        });
        expect(binds).toBe(1);
      }),
    ),
  );

  it.live(
    "rejects owner ID and generation changes without rebinding or creating another execution",
    () =>
      withGoalExecutions((database) =>
        Effect.gen(function* () {
          const goals = yield* GoalExecutions;
          let binds = 0;
          yield* goals.admitAndStart(
            payload,
            Effect.sync((): Admission => {
              binds += 1;
              return { status: "bound", binding };
            }),
          );
          for (const owner of [
            { ownerId: "project-2", generation: "generation-1" },
            { ownerId: "project-1", generation: "generation-2" },
          ]) {
            const changedOwner: GoalExecutionPayload = {
              ...payload,
              identity: { ...payload.identity, owner },
            };
            const failure = yield* goals
              .admitAndStart(
                changedOwner,
                Effect.sync((): Admission => {
                  binds += 1;
                  return { status: "bound", binding };
                }),
              )
              .pipe(Effect.flip);
            expect(failure).toEqual(
              GoalExecutionAdmissionRefused.make({ reason: "owner_mismatch" }),
            );
          }
          expect(binds).toBe(1);
          expect(
            database.sqlite.prepare("SELECT count(*) AS n FROM owner_workflow_executions").get(),
          ).toEqual({ n: 1 });
        }),
      ),
  );

  it.live("persists a failed durable completion before returning", () =>
    withGoalExecutions((database) =>
      Effect.gen(function* () {
        const goals = yield* GoalExecutions;
        yield* goals.admitAndStart(
          payload,
          Effect.succeed<Admission>({ status: "bound", binding }),
        );
        yield* goals.fail(payload, {
          _tag: "SideEffectUncertain",
          operationId: "1",
          state: "uncertain",
        });
        expect(
          database.sqlite.prepare("SELECT status FROM owner_workflow_executions").get(),
        ).toEqual({ status: "completed" });
      }),
    ),
  );

  it.live("rolls back both binding work and durable request when owner binding refuses", () =>
    withGoalExecutions((database) =>
      Effect.gen(function* () {
        database.sqlite.exec("CREATE TABLE goal_execution_binding_probe (id TEXT PRIMARY KEY)");
        const goals = yield* GoalExecutions;
        const failure = yield* goals
          .admitAndStart(
            payload,
            Effect.sync((): Admission => {
              database.sqlite
                .prepare("INSERT INTO goal_execution_binding_probe VALUES (?)")
                .run("rolled-back");
              return { status: "refused", reason: "workflow_changed" };
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(GoalExecutionAdmissionRefused);
        expect(
          database.sqlite.prepare("SELECT id FROM goal_execution_binding_probe").all(),
        ).toEqual([]);
        expect(
          database.sqlite.prepare("SELECT execution_id FROM owner_workflow_executions").all(),
        ).toEqual([]);
      }),
    ),
  );
});
