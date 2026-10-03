import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import type { RunBinding } from "../workflow/run-bindings.ts";

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

export function goalWorkerAuthority(owner: {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
}) {
  const { sqlite, atomic } = owner;
  const issued = new Map<string, GoalWorkerCapability>();
  const byRun = new Map<string, string>();
  const binding = sqlite.prepare(`
    SELECT session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id
    FROM workflow_run_bindings WHERE run_id = ?
  `);
  const status = sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?");
  const dispatch = sqlite.prepare(
    "SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?",
  );
  const reserve = sqlite.prepare(`
    INSERT INTO workflow_worker_dispatches (run_id, generation, created_at)
    VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING
  `);
  const active = (claim: RunBinding, finalization = false) => {
    const row = Schema.decodeUnknownSync(
      Schema.UndefinedOr(
        Schema.Struct({
          session_id: Schema.String,
          goal_instance_id: Schema.String,
          goal_version: Schema.Finite,
          plan_version: Schema.NullOr(Schema.Finite),
          workflow_revision_id: Schema.Finite,
        }),
      ),
    )(binding.get(claim.runId));
    if (
      !row ||
      row.session_id !== claim.sessionId ||
      row.goal_instance_id !== claim.goalInstanceId ||
      row.goal_version !== claim.goalVersion ||
      row.plan_version !== claim.planVersion ||
      row.workflow_revision_id !== claim.workflowRevisionId
    )
      return false;
    const run = Schema.decodeUnknownSync(
      Schema.UndefinedOr(Schema.Struct({ status: Schema.String })),
    )(status.get(claim.runId));
    // A completed/failed/aborted run must never accept a late chunk or tool RPC.
    return finalization || !run || run.status === "running" || run.status === "interrupted";
  };

  const permits = (claim: GoalWorkerClaim, finalization = false): boolean => {
    if (!claim.requestId) return false;
    const expected = issued.get(claim.token);
    return Boolean(
      expected &&
      Object.entries(expected).every(
        // SAFETY: keys come from the owner's frozen issued capability, not from
        // worker input; the indexed access only compares that issued value.
        ([key, value]) => value === claim[key as keyof GoalWorkerCapability],
      ) &&
      Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.Struct({ generation: Schema.String })))(
        dispatch.get(claim.runId),
      )?.generation === claim.generation &&
      active(claim, finalization),
    );
  };

  return {
    issue(claim: RunBinding, generation: string): GoalWorkerCapability | null {
      if (!generation) return null;
      // Commit a single dispatch before exposing the ephemeral token to any worker.
      // After a crash the DB marker persists, so even a replacement owner refuses
      // automatic re-execution when an effect's outcome could be unknown.
      const reserved = atomic(() => {
        if (byRun.has(claim.runId) || !active(claim) || status.get(claim.runId)) return false;
        return reserve.run(claim.runId, generation, new Date().toISOString()).changes === 1;
      });
      if (!reserved) return null;
      const capability = Object.freeze({ ...claim, generation, token: randomUUID() });
      issued.set(capability.token, capability);
      byRun.set(claim.runId, capability.token);
      return capability;
    },
    permits: (claim: GoalWorkerClaim) => permits(claim),
    /** Owner-only cleanup fence. Call only inside an owner-classified finalization scope. */
    permitsFinalization: (claim: GoalWorkerClaim) => permits(claim, true),
    revoke(runId: string): void {
      const token = byRun.get(runId);
      if (token) issued.delete(token);
      byRun.delete(runId);
    },
  };
}
