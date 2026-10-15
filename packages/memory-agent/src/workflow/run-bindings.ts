import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { DateTime, Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";
import { recoveredReadRunSql } from "../agent/owner-read-recovery.ts";
import { readOnlyToolNames } from "../tools/effects.ts";

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

/**
 * An owner operation that may have run a tool. Middleware hooks and routed persistence are owner
 * bookkeeping and repeat nothing outside; a fingerprint that does not name its operation counts as
 * a tool.
 */
export const toolOperationSql = (operation: string) => `(${operation}.side_effect = 1
  AND coalesce(CASE WHEN json_valid(${operation}.fingerprint)
    THEN json_extract(${operation}.fingerprint, '$.operation') END, '')
    NOT IN ('middleware', 'routedPersistence'))`;

/** A string field of the owner-encoded tool invocation in a tool operation's fingerprint. */
export const invocationFieldSql: {
  (field: "name" | "toolCallId"): (operation: string) => string;
  (operation: string, field: "name" | "toolCallId"): string;
} = EffectFunction.dual(
  2,
  (operation: string, field: "name" | "toolCallId") =>
    `(SELECT json_extract(f.value, '$[1][1]') FROM json_each(${operation}.fingerprint, '$.input[1]') f
    WHERE json_extract(f.value, '$[0]') = '${field}')`,
);

// Built-in names are fixed constants, never request input.
const readOnlyToolsSql = [...readOnlyToolNames].map((name) => `'${name}'`).join(", ");

/**
 * A bound run that ended without completing, after which a later run cannot repeat anything it did
 * without knowing it. Every tool it ran succeeded, and each one that may change something has its
 * result in the session's recorded history, which the later run reads; a read-only tool cannot be
 * repeated harmfully even when the run stopped before recording it. Authorizing a tool runs
 * nothing. That run may continue the Plan as a new turn; nothing is replayed. A tool still pending
 * or uncertain, a recorded-less effectful tool, or an operation that names no known tool step keeps
 * the session fenced.
 */
export const endedWithKnownEffectsSql = (
  run: string,
) => `(coalesce(${run}.status IN ('failed', 'aborted'), 0)
  AND NOT EXISTS (SELECT 1 FROM owner_rpc_operations eo
    WHERE eo.run_id = ${run}.run_id AND ${toolOperationSql("eo")} AND (eo.status <> 'succeeded'
      OR NOT json_valid(eo.fingerprint)
      OR coalesce(json_extract(eo.fingerprint, '$.operation'), '') NOT IN ('tool', 'toolAuthorize')
      OR json_extract(eo.fingerprint, '$.operation') = 'tool'
        AND coalesce(${invocationFieldSql("eo", "name")}, '') NOT IN (${readOnlyToolsSql})
        AND NOT EXISTS (SELECT 1 FROM nodes n
          WHERE n.session_id = ${run}.thread_id AND n.kind = 'tool_result'
            AND json_extract(n.detail, '$.toolCallId') = ${invocationFieldSql("eo", "toolCallId")}))))`;

/**
 * A bound run whose unknown outcome the user saw and chose to continue past. `binding` names a
 * `workflow_run_bindings` row.
 */
export const acknowledgedRunSql = (binding: string) => `EXISTS (
  SELECT 1 FROM workflow_uncertain_acknowledgements ack WHERE ack.run_id = ${binding}.run_id)`;

/**
 * A bound run that ended without completing and still leaves later runs nothing to guess about:
 * an operator recovered it, everything it did is known, or the user chose to continue past it.
 */
export const resolvedRunSql: {
  (run: "r"): (binding: string) => string;
  (binding: string, run: "r"): string;
} = EffectFunction.dual(
  2,
  (binding: string, run: "r") =>
    `(${recoveredReadRunSql(run)} OR ${endedWithKnownEffectsSql(run)} OR ${acknowledgedRunSql(binding)})`,
);

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
    WHERE b.session_id = ? AND NOT ${acknowledgedRunSql("b")}
      AND (r.status IS NULL OR (r.status <> 'completed' AND NOT (
      ${resolvedRunSql("b", "r")}
      OR r.status = 'interrupted' AND EXISTS (SELECT 1 FROM chat_interrupts i WHERE i.run_id = r.run_id)
      AND (r.run_id = ? OR NOT EXISTS (SELECT 1 FROM chat_interrupts i WHERE i.run_id = r.run_id AND i.status = 'pending'))
    ))) LIMIT 1
  `);
  const unresolved = sqlite.prepare(`
    SELECT operations.operation_id FROM owner_rpc_operations AS operations
    JOIN workflow_run_bindings AS binding ON binding.run_id = operations.run_id
    LEFT JOIN chat_runs r ON r.run_id = binding.run_id
    WHERE binding.session_id = ? AND binding.goal_instance_id = ?
      AND (operations.status = 'pending'
        OR (operations.side_effect = 1 AND operations.status <> 'succeeded'))
      AND NOT ${resolvedRunSql("binding", "r")} LIMIT 1
  `);
  const claimed = sqlite.prepare("SELECT run_id FROM workflow_run_bindings WHERE run_id = ?");
  const insert = sqlite.prepare(`
    INSERT INTO workflow_run_bindings
      (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const bind = (
    sessionId: string,
    runId: string,
    expectedRevisionId: number,
    resumeRunId?: string,
    mode: "commit" | "preview" = "commit",
  ): Admission =>
    atomic(() => {
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      const goal = EffectFunction.flow(
        Schema.decodeUnknownResult(
          Schema.UndefinedOr(Schema.Struct({ goal_instance_id: Schema.String })),
        ),
        Result.getOrThrow,
      )(identity.get(sessionId));
      if (!isTruthy(goal)) return { status: "refused", reason: "legacy_unbound" };
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      const state = EffectFunction.flow(
        Schema.decodeUnknownResult(
          Schema.UndefinedOr(
            Schema.Struct({
              id: Schema.Finite,
              goal_instance_id: Schema.NullOr(Schema.String),
              goal_version: Schema.NullOr(Schema.Finite),
              plan_version: Schema.NullOr(Schema.Finite),
            }),
          ),
        ),
        Result.getOrThrow,
      )(latest.get(sessionId));
      if (
        !isTruthy(state) ||
        state.id !== expectedRevisionId ||
        state.goal_instance_id !== goal.goal_instance_id ||
        state.goal_version === null
      )
        return { status: "refused", reason: "workflow_changed" };
      if (isTruthy(claimed.get(runId)) || isTruthy(otherRun.get(runId)))
        return { status: "refused", reason: "run_id_conflict" };
      // A crashed, aborted or failed run may have performed an external side effect.
      // Do not silently start another one until the owner can prove or resolve it.
      // SDK completion does not prove every owner operation settled. Inspect all
      // bindings for this Goal, including older Goal/Plan versions, before admission.
      // Pending reads may still settle; uncertain reads alone cannot replay an effect.
      if (
        isTruthy(previous.get(sessionId, resumeRunId ?? "")) ||
        isTruthy(unresolved.get(sessionId, goal.goal_instance_id))
      )
        return { status: "refused", reason: "run_outcome_uncertain" };
      switch (mode) {
        case "commit":
          insert.run(
            runId,
            sessionId,
            goal.goal_instance_id,
            state.goal_version,
            state.plan_version,
            state.id,
            DateTime.formatIso(DateTime.nowUnsafe()),
          );
          break;
        case "preview":
          break;
      }
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
  return {
    bind,
    preview: (sessionId: string, runId: string, revisionId: number) =>
      bind(sessionId, runId, revisionId, undefined, "preview"),
  };
}
