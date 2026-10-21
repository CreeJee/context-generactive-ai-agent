import { DateTime, Effect, Match, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";

const Pin = Schema.Struct({
  goalInstanceId: Schema.String,
  sourceGeneration: Schema.String,
  manifestHash: Schema.String,
  workerUrl: Schema.String,
});
export type GoalWorkerGenerationPin = typeof Pin.Type;

export class GoalWorkerGenerationError extends Schema.TaggedError<GoalWorkerGenerationError>()(
  "GoalWorkerGenerationError",
  {
    reason: Schema.Literals(["already_pinned", "unrecoverable_pin", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const rejected = (reason: "already_pinned" | "unrecoverable_pin") =>
  GoalWorkerGenerationError.make({ reason });

const stored = (
  cause: GoalWorkerGenerationError | SqlError.SqlError | Schema.SchemaError,
): GoalWorkerGenerationError =>
  Match.valueTags(cause, {
    GoalWorkerGenerationError: (cause) => cause,
    SqlError: (cause) => GoalWorkerGenerationError.make({ reason: "storage", cause }),
    SchemaError: (cause) => GoalWorkerGenerationError.make({ reason: "storage", cause }),
  });

/** Durable source identity only. This never reissues a run token or adopts a live worker. */
export const goalWorkerGenerationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Pin,
    execute: (goalInstanceId) => sql`SELECT goal_instance_id AS goalInstanceId,
      source_generation AS sourceGeneration, manifest_hash AS manifestHash, worker_url AS workerUrl
      FROM workflow_goal_worker_generations WHERE goal_instance_id = ${goalInstanceId}`,
  });
  // A previous dispatch proves code ran, but not which source assets it used.
  // Never invent a generation for an old Goal or auto-reexecute its runs.
  const refuseUnpinnedDispatch = (goalInstanceId: string) =>
    sql`SELECT 1 FROM workflow_worker_dispatches d
      JOIN workflow_run_bindings b ON b.run_id = d.run_id
      WHERE b.goal_instance_id = ${goalInstanceId} LIMIT 1`.pipe(
      Effect.filterOrFail(
        (rows) => rows.length === 0,
        () => rejected("unrecoverable_pin"),
      ),
    );
  return {
    /** The Goal's pin; a Goal that already executed without one is never treated as new. */
    pinned: (goalInstanceId: string) =>
      read(goalInstanceId).pipe(
        Effect.tap(
          Option.match({
            onSome: () => Effect.void,
            onNone: () => refuseUnpinnedDispatch(goalInstanceId),
          }),
        ),
        Effect.mapError(stored),
      ),
    record: (pin: GoalWorkerGenerationPin) =>
      read(pin.goalInstanceId).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (existing) =>
              existing.sourceGeneration === pin.sourceGeneration &&
              existing.manifestHash === pin.manifestHash &&
              existing.workerUrl === pin.workerUrl
                ? Effect.succeed(existing)
                : Effect.fail(rejected("already_pinned")),
            onNone: () =>
              refuseUnpinnedDispatch(pin.goalInstanceId).pipe(
                Effect.andThen(DateTime.now),
                Effect.flatMap(
                  (now) =>
                    sql`INSERT INTO workflow_goal_worker_generations ${sql.insert({
                      goal_instance_id: pin.goalInstanceId,
                      source_generation: pin.sourceGeneration,
                      manifest_hash: pin.manifestHash,
                      worker_url: pin.workerUrl,
                      created_at: DateTime.formatIso(now),
                    })}`,
                ),
                Effect.as(pin),
              ),
          }),
        ),
        sql.withTransaction,
        Effect.mapError(stored),
      ),
  };
});
