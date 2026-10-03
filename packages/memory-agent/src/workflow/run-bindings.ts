import { Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";

type OwnerDatabase = {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
};

export type RunBinding = {
  readonly runId: string;
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly goalVersion: number;
  readonly planVersion: number | null;
  readonly workflowRevisionId: number;
};

export type Admission =
  | { readonly status: "bound"; readonly binding: RunBinding }
  | {
      readonly status: "refused";
      readonly reason:
        | "legacy_unbound"
        | "workflow_changed"
        | "run_id_conflict"
        | "run_outcome_uncertain";
    };

/** A central-owner-only durable claim; it cannot authorize a worker or a tool on its own. */
export function workflowRunBindings({ sqlite, atomic }: OwnerDatabase) {
  const identity = sqlite.prepare(
    "SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?",
  );
  const latest = sqlite.prepare(`
    SELECT id, goal_instance_id, goal_version, plan_version
    FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1
  `);
  const otherRun = sqlite.prepare("SELECT thread_id FROM chat_runs WHERE run_id = ?");
  const previous = sqlite.prepare(`
    SELECT b.run_id FROM workflow_run_bindings b
    LEFT JOIN chat_runs r ON r.run_id = b.run_id
    WHERE b.session_id = ? AND (r.status IS NULL OR r.status <> 'completed') LIMIT 1
  `);
  const unresolved = sqlite.prepare(`
    SELECT operations.operation_id FROM owner_rpc_operations AS operations
    JOIN workflow_run_bindings AS binding ON binding.run_id = operations.run_id
    WHERE binding.session_id = ? AND binding.goal_instance_id = ?
      AND (operations.status = 'pending'
        OR (operations.side_effect = 1 AND operations.status <> 'succeeded')) LIMIT 1
  `);
  const claimed = sqlite.prepare("SELECT run_id FROM workflow_run_bindings WHERE run_id = ?");
  const insert = sqlite.prepare(`
    INSERT INTO workflow_run_bindings
      (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const bind = (sessionId: string, runId: string, expectedRevisionId: number): Admission =>
    atomic(() => {
      const goal = Schema.decodeUnknownSync(
        Schema.UndefinedOr(Schema.Struct({ goal_instance_id: Schema.String })),
      )(identity.get(sessionId));
      if (!goal) return { status: "refused", reason: "legacy_unbound" };
      const state = Schema.decodeUnknownSync(
        Schema.UndefinedOr(
          Schema.Struct({
            id: Schema.Finite,
            goal_instance_id: Schema.NullOr(Schema.String),
            goal_version: Schema.NullOr(Schema.Finite),
            plan_version: Schema.NullOr(Schema.Finite),
          }),
        ),
      )(latest.get(sessionId));
      if (
        !state ||
        state.id !== expectedRevisionId ||
        state.goal_instance_id !== goal.goal_instance_id ||
        state.goal_version === null
      )
        return { status: "refused", reason: "workflow_changed" };
      if (claimed.get(runId) || otherRun.get(runId))
        return { status: "refused", reason: "run_id_conflict" };
      // A crashed, aborted or failed run may have performed an external side effect.
      // Do not silently start another one until the owner can prove or resolve it.
      // SDK completion does not prove every owner operation settled. Inspect all
      // bindings for this Goal, including older Goal/Plan versions, before admission.
      // Pending reads may still settle; uncertain reads alone cannot replay an effect.
      if (previous.get(sessionId) || unresolved.get(sessionId, goal.goal_instance_id))
        return { status: "refused", reason: "run_outcome_uncertain" };
      insert.run(
        runId,
        sessionId,
        goal.goal_instance_id,
        state.goal_version,
        state.plan_version,
        state.id,
        new Date().toISOString(),
      );
      return {
        status: "bound",
        binding: {
          runId,
          sessionId,
          goalInstanceId: goal.goal_instance_id,
          goalVersion: state.goal_version,
          planVersion: state.plan_version,
          workflowRevisionId: state.id,
        },
      };
    });
  return { bind };
}
