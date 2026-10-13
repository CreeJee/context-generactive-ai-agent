import { DateTime, HashSet, Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";
import { readOnlyToolNames } from "../tools/effects.ts";
import { invocationFieldSql, resolvedRunSql, toolOperationSql } from "./run-bindings.ts";

type OwnerDatabase = {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
};

/**
 * How a tool of an ended run left its outcome unknown: its owner operation never settled
 * (`pending`, `uncertain`, `rejected`), or it succeeded but its result never reached the history a
 * later run reads (`unrecorded`).
 */
export type UncertainToolState = "pending" | "uncertain" | "rejected" | "unrecorded";

export interface UncertainTool {
  readonly toolCallId: string | null;
  readonly name: string | null;
  /** The recorded call with secrets hidden; null when the run stopped before recording it. */
  readonly call: string | null;
  readonly state: UncertainToolState;
}

/** A bound Goal run that keeps later runs from starting until the user decides about it. */
export interface UncertainRun {
  readonly runId: string;
  readonly tools: readonly UncertainTool[];
}

/** The runs the user saw listed, all of which the continue covers. */
export const UncertainContinueRequest = Schema.Struct({ runIds: Schema.Array(Schema.String) });
export type UncertainContinueRequest = typeof UncertainContinueRequest.Type;

export type UncertainContinue =
  | { readonly status: "acknowledged" }
  | { readonly status: "refused"; readonly reason: "run_in_progress" | "uncertain_runs_changed" };

const Operation = Schema.Struct({
  status: Schema.Literals(["pending", "succeeded", "uncertain", "rejected"]),
  operation: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  toolCallId: Schema.NullOr(Schema.String),
  call: Schema.NullOr(Schema.String),
  recorded: Schema.Finite,
});
const decodeRuns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ runId: Schema.String })));
const decodeOperations = Schema.decodeUnknownSync(Schema.Array(Operation));

const stateOf = (operation: typeof Operation.Type): UncertainToolState | null => {
  switch (operation.status) {
    case "pending":
    case "uncertain":
    case "rejected":
      return operation.status;
    case "succeeded":
      return operation.operation === "tool" &&
        !HashSet.has(readOnlyToolNames, operation.name ?? "") &&
        operation.recorded === 0
        ? "unrecorded"
        : null;
  }
};

/**
 * Bound runs that admission refuses to start past, and the user's choice to continue anyway. Runs
 * still producing or waiting on an approval are not listed: those settle by themselves.
 */
export function uncertainRuns({ sqlite, atomic }: OwnerDatabase) {
  const blocking = sqlite.prepare(`
    SELECT b.run_id AS runId FROM workflow_run_bindings b
    LEFT JOIN chat_runs r ON r.run_id = b.run_id
    WHERE b.session_id = ? AND coalesce(r.status, '') <> 'running'
      AND NOT (r.status = 'interrupted' AND EXISTS (SELECT 1 FROM chat_interrupts i WHERE i.run_id = r.run_id))
      AND NOT ${resolvedRunSql("b", "r")}
      AND (coalesce(r.status, '') <> 'completed' OR EXISTS (SELECT 1 FROM owner_rpc_operations o
        WHERE o.run_id = b.run_id AND (o.status = 'pending' OR (o.side_effect = 1 AND o.status <> 'succeeded'))))
    ORDER BY b.created_at, b.run_id`);
  // A fingerprint that is not JSON names no tool; it still counts, with no name to show.
  const field = (name: "name" | "toolCallId") =>
    `CASE WHEN json_valid(o.fingerprint) THEN ${invocationFieldSql("o", name)} END`;
  const operations = sqlite.prepare(`
    SELECT o.status,
      CASE WHEN json_valid(o.fingerprint) THEN json_extract(o.fingerprint, '$.operation') END AS operation,
      ${field("name")} AS name, ${field("toolCallId")} AS toolCallId,
      (SELECT n.text FROM nodes n WHERE n.session_id = b.session_id AND n.kind = 'tool_call'
        AND json_extract(n.detail, '$.toolCallId') = ${field("toolCallId")} ORDER BY n.seq LIMIT 1) AS call,
      EXISTS (SELECT 1 FROM nodes n WHERE n.session_id = b.session_id AND n.kind = 'tool_result'
        AND json_extract(n.detail, '$.toolCallId') = ${field("toolCallId")}) AS recorded
    FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id = o.run_id
    WHERE o.run_id = ? AND ${toolOperationSql("o")}
    ORDER BY o.operation_id`);
  const producing = sqlite.prepare(`
    SELECT 1 FROM chat_runs WHERE thread_id = ? AND status = 'running'
    UNION ALL SELECT 1 FROM owner_workflow_executions
    WHERE workflow_name = 'GoalExecution' AND status IN ('running', 'suspended')
      AND json_extract(payload_json, '$.identity.sessionId') = ?
    LIMIT 1`);
  const insert = sqlite.prepare(`
    INSERT INTO workflow_uncertain_acknowledgements (run_id, session_id, acknowledged_at)
    VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);

  const tools = (runId: string): UncertainTool[] => {
    // An authorization and the call it allowed share one tool call id; show the call once.
    const seen = new Set<string>();
    return decodeOperations(operations.all(runId)).flatMap((operation) => {
      const state = stateOf(operation);
      if (state === null) return [];
      if (operation.toolCallId !== null) {
        if (seen.has(operation.toolCallId)) return [];
        seen.add(operation.toolCallId);
      }
      return [
        { toolCallId: operation.toolCallId, name: operation.name, call: operation.call, state },
      ];
    });
  };

  const list = (sessionId: string): UncertainRun[] =>
    decodeRuns(blocking.all(sessionId)).map(({ runId }) => ({ runId, tools: tools(runId) }));

  return {
    list,
    /**
     * Records that the user saw exactly `runIds` and chose to continue. Refused while something
     * still runs, or when the runs left unknown changed since the user looked.
     */
    acknowledge: (sessionId: string, runIds: readonly string[]): UncertainContinue =>
      atomic(() => {
        if (producing.get(sessionId, sessionId) !== undefined)
          return { status: "refused", reason: "run_in_progress" };
        const current = list(sessionId).map((run) => run.runId);
        const asked = new Set(runIds);
        if (
          current.length === 0 ||
          current.length !== asked.size ||
          !current.every((id) => asked.has(id))
        )
          return { status: "refused", reason: "uncertain_runs_changed" };
        const at = DateTime.formatIso(DateTime.nowUnsafe());
        for (const runId of current) insert.run(runId, sessionId, at);
        return { status: "acknowledged" };
      }),
  };
}
