import { Crypto, DateTime, Effect, MutableHashMap, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import type { RunBinding } from "../workflow/run-bindings.ts";
import { OwnerAuthorityError } from "./owner-rpc.ts";

/**
 * An owner-process-only fence for messages from a Goal execution generation.
 * The token is never persisted or sent to the browser. Losing the owner process
 * invalidates every token; a new owner must explicitly decide what to do with
 * still-persisted, uncertain runs rather than adopting an old worker's reply.
 */
export interface GoalWorkerCapability extends RunBinding {
  readonly generation: string;
  readonly token: string;
}

export type GoalWorkerClaim = GoalWorkerCapability & { readonly requestId: string };

const BindingRow = Schema.Struct({
  session_id: Schema.String,
  goal_instance_id: Schema.String,
  goal_version: Schema.Finite,
  plan_version: Schema.NullOr(Schema.Finite),
  workflow_revision_id: Schema.Finite,
});

export const goalWorkerAuthority = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const issued = MutableHashMap.empty<string, GoalWorkerCapability>();
  const binding = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: BindingRow,
    execute: (runId) => sql`
      SELECT session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id
      FROM workflow_run_bindings WHERE run_id = ${runId}`,
  });
  const status = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ status: Schema.String }),
    execute: (runId) => sql`SELECT status FROM chat_runs WHERE run_id = ${runId}`,
  });
  const dispatch = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ generation: Schema.String }),
    execute: (runId) =>
      sql`SELECT generation FROM workflow_worker_dispatches WHERE run_id = ${runId}`,
  });
  // Annotated: `fnUntraced` types an unannotated defaulted parameter as `any`.
  const active = Effect.fnUntraced(function* (claim: RunBinding, finalization: boolean = false) {
    const row = Option.getOrUndefined(yield* binding(claim.runId));
    if (
      row === undefined ||
      row.session_id !== claim.sessionId ||
      row.goal_instance_id !== claim.goalInstanceId ||
      row.goal_version !== claim.goalVersion ||
      row.plan_version !== claim.planVersion ||
      row.workflow_revision_id !== claim.workflowRevisionId
    )
      return false;
    const run = Option.getOrUndefined(yield* status(claim.runId));
    // A completed/failed/aborted run must never accept a late chunk or tool RPC.
    return (
      finalization || run === undefined || run.status === "running" || run.status === "interrupted"
    );
  });

  const permits = (claim: GoalWorkerClaim, finalization = false) =>
    Effect.gen(function* () {
      if (!(claim.requestId.length > 0)) return false;
      const expected = Option.getOrUndefined(MutableHashMap.get(issued, claim.runId));
      if (
        expected === undefined ||
        !Object.entries(expected).every(
          // SAFETY: keys come from the owner's frozen issued capability, not from
          // worker input; the indexed access only compares that issued value.
          ([key, value]) => value === claim[key as keyof GoalWorkerCapability],
        )
      )
        return false;
      const dispatched = Option.getOrUndefined(yield* dispatch(claim.runId));
      return dispatched?.generation === claim.generation && (yield* active(claim, finalization));
    }).pipe(Effect.mapError((cause) => OwnerAuthorityError.make({ cause })));

  return {
    issue: Effect.fnUntraced(function* (claim: RunBinding, generation: string) {
      if (!(generation.length > 0)) return null;
      const token = yield* crypto.randomUUIDv4();
      // Commit a single dispatch before exposing the ephemeral token to any worker.
      // After a crash the DB marker persists, so even a replacement owner refuses
      // automatic re-execution when an effect's outcome could be unknown.
      const reserved = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            MutableHashMap.has(issued, claim.runId) ||
            !(yield* active(claim)) ||
            Option.isSome(yield* status(claim.runId))
          )
            return false;
          const inserted = yield* sql`
            INSERT INTO workflow_worker_dispatches (run_id, generation, created_at)
            VALUES (${claim.runId}, ${generation}, ${DateTime.formatIso(yield* DateTime.now)})
            ON CONFLICT(run_id) DO NOTHING RETURNING run_id`;
          return inserted.length === 1;
        }),
      );
      if (!reserved) return null;
      const capability: GoalWorkerCapability = Object.freeze({ ...claim, generation, token });
      MutableHashMap.set(issued, claim.runId, capability);
      return capability;
    }),
    permits: (claim: GoalWorkerClaim) => permits(claim),
    /** Owner-only cleanup fence. Call only inside an owner-classified finalization scope. */
    permitsFinalization: (claim: GoalWorkerClaim) => permits(claim, true),
    revoke(runId: string): void {
      MutableHashMap.remove(issued, runId);
    },
  };
});
