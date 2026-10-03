import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const Pin = Schema.Struct({
  goalInstanceId: Schema.String,
  sourceGeneration: Schema.String,
  manifestHash: Schema.String,
  workerUrl: Schema.String,
});
export type GoalWorkerGenerationPin = typeof Pin.Type;

/** Durable source identity only. This never reissues a run token or adopts a live worker. */
export function makeGoalWorkerGenerationStore(owner: {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
}) {
  const read = owner.sqlite.prepare(`SELECT goal_instance_id AS goalInstanceId,
    source_generation AS sourceGeneration, manifest_hash AS manifestHash, worker_url AS workerUrl
    FROM workflow_goal_worker_generations WHERE goal_instance_id = ?`);
  const oldDispatch = owner.sqlite.prepare(`SELECT 1 FROM workflow_worker_dispatches d
    JOIN workflow_run_bindings b ON b.run_id = d.run_id WHERE b.goal_instance_id = ? LIMIT 1`);
  const insert = owner.sqlite.prepare(`INSERT INTO workflow_goal_worker_generations
    (goal_instance_id, source_generation, manifest_hash, worker_url, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const decode = Schema.decodeUnknownSync(Schema.UndefinedOr(Pin));
  return {
    get: (goalInstanceId: string) => decode(read.get(goalInstanceId)),
    hasUnpinnedDispatch: (goalInstanceId: string) => Boolean(oldDispatch.get(goalInstanceId)),
    record(pin: GoalWorkerGenerationPin): GoalWorkerGenerationPin {
      const expected = Schema.decodeUnknownSync(Pin)(pin);
      return owner.atomic(() => {
        const existing = decode(read.get(expected.goalInstanceId));
        if (existing) {
          if (
            existing.sourceGeneration !== expected.sourceGeneration ||
            existing.manifestHash !== expected.manifestHash ||
            existing.workerUrl !== expected.workerUrl
          )
            throw new Error("Goal source generation is already pinned");
          return existing;
        }
        // A previous dispatch proves code ran, but not which source assets it used.
        // Never invent a generation for an old Goal or auto-reexecute its runs.
        if (oldDispatch.get(expected.goalInstanceId))
          throw new Error("Existing Goal execution has no recoverable source pin");
        insert.run(
          expected.goalInstanceId,
          expected.sourceGeneration,
          expected.manifestHash,
          expected.workerUrl,
          new Date().toISOString(),
        );
        return expected;
      });
    },
  };
}
