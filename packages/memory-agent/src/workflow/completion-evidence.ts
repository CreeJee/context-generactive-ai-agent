import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import type { DatabaseSync } from "node:sqlite";
import { MutableHashMap, MutableHashSet, Schema } from "effect";
import type { WorkflowState } from "./workflow.ts";

/** Only the current Plan version is supported; historical Plan mappings are not adopted. */
export const CriterionMapping = Schema.Struct({
  outcomeIndex: Schema.Int,
  outcomeText: Schema.String,
  stepId: Schema.String,
  acceptanceIndex: Schema.Int,
  acceptanceText: Schema.String,
  runId: Schema.String,
  evidenceNodeIds: Schema.Array(Schema.String),
});
const RunProvenance = Schema.Struct({
  runId: Schema.String,
  workflowRevisionId: Schema.Int,
  dispatchGeneration: Schema.NullOr(Schema.String),
  // Additive for 0.0.13 snapshots; source-bound runs always populate it.
  durableExecutionId: Schema.optionalKey(Schema.String),
});
export const CompletionSnapshot = Schema.Struct({
  sessionId: Schema.String,
  projectId: Schema.String,
  goalInstanceId: Schema.String,
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  recorderRunId: Schema.String,
  recorderRevisionId: Schema.Int,
  sourceGeneration: Schema.NullOr(Schema.String),
  manifestHash: Schema.NullOr(Schema.String),
  nativeRegistration: Schema.NullOr(
    Schema.Struct({
      artifactHash: Schema.String,
      sourceHash: Schema.String,
      contractVersion: Schema.String,
    }),
  ),
  mappings: Schema.Array(CriterionMapping),
  runs: Schema.Array(RunProvenance),
});
export type CompletionSnapshot = typeof CompletionSnapshot.Type;
export type CriterionMapping = typeof CriterionMapping.Type;

/** A proposal is never completion evidence; the owner validates it after durable settlement. */
export const CompletionRequest = Schema.Struct({
  recorderRunId: Schema.String,
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  mappings: Schema.Array(CriterionMapping),
});

const Binding = Schema.Struct({
  session_id: Schema.String,
  goal_instance_id: Schema.String,
  goal_version: Schema.Int,
  plan_version: Schema.NullOr(Schema.Int),
  workflow_revision_id: Schema.Int,
});
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const optionalBinding = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.UndefinedOr(Binding)),
  Result.getOrThrow,
);
const Registration = Schema.Struct({
  artifactHash: Schema.String,
  sourceHash: Schema.String,
  contractVersion: Schema.String,
});

/** Owner-side DB boundary; no code, credentials or artifact bytes enter the snapshot. */
export function completionEvidence(sqlite: DatabaseSync) {
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const optionalString = EffectFunction.flow(
    Schema.decodeUnknownResult(Schema.UndefinedOr(Schema.String)),
    Result.getOrThrow,
  );
  const identity = (sessionId: string) =>
    optionalString(
      sqlite
        .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
        .get(sessionId)?.goal_instance_id,
    );
  const required = (sessionId: string) => {
    const id = identity(sessionId);
    return (
      id !== undefined &&
      Boolean(
        sqlite
          .prepare(
            `SELECT 1 FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?
       UNION ALL SELECT 1 FROM workflow_goal_worker_generations WHERE goal_instance_id = ? LIMIT 1`,
          )
          .get(id, id),
      )
    );
  };
  const derive = (
    sessionId: string,
    state: WorkflowState,
    mappings: readonly CriterionMapping[],
    recorderRunId: string,
    pendingRecorder = false,
  ):
    | { readonly status: "accepted"; readonly snapshot: CompletionSnapshot }
    | { readonly status: "refused" } => {
    const goal = state.goal;
    const plan = state.plan;
    const goalId = identity(sessionId);
    const projectId = optionalString(
      sqlite.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId)?.project_id,
    );
    if (
      !isTruthy(goal) ||
      !isTruthy(plan) ||
      goalId === undefined ||
      projectId === undefined ||
      plan.goalVersion !== goal.version ||
      mappings.length === 0
    )
      return { status: "refused" };
    const source = sqlite
      .prepare(`SELECT source_generation, manifest_hash
      FROM workflow_goal_worker_generations WHERE goal_instance_id = ?`)
      .get(goalId);
    const sourceGeneration = optionalString(source?.source_generation);
    const binding = (runId: string) =>
      optionalBinding(
        sqlite.prepare("SELECT * FROM workflow_run_bindings WHERE run_id = ?").get(runId),
      );
    const valid = (runId: string) => {
      const bound = binding(runId);
      const run = sqlite
        .prepare("SELECT thread_id, status FROM chat_runs WHERE run_id = ?")
        .get(runId);
      const revision =
        bound &&
        sqlite
          .prepare(`SELECT session_id, goal_instance_id,
        goal_version, plan_version FROM workflow_state_revisions WHERE id = ?`)
          .get(bound.workflow_revision_id);
      return isTruthy(bound) &&
        run?.thread_id === sessionId &&
        (run.status === "completed" || (runId === recorderRunId && run.status === "running")) &&
        bound.session_id === sessionId &&
        bound.goal_instance_id === goalId &&
        bound.goal_version === goal.version &&
        bound.plan_version === plan.version &&
        revision?.session_id === sessionId &&
        revision.goal_instance_id === goalId &&
        revision.goal_version === goal.version &&
        revision.plan_version === plan.version
        ? bound
        : null;
    };
    const provenance = (runId: string, bound: typeof Binding.Type) => {
      if (pendingRecorder && runId === recorderRunId) {
        const dispatch = optionalString(
          sqlite
            .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
            .get(runId)?.generation,
        );
        if (sourceGeneration !== undefined && dispatch === undefined) return null;
        return {
          runId,
          workflowRevisionId: bound.workflow_revision_id,
          dispatchGeneration: dispatch ?? null,
        };
      }
      const unresolved = sqlite
        .prepare(
          `SELECT 1 FROM owner_rpc_operations WHERE run_id = ?
           AND (status = 'pending' OR (side_effect = 1 AND status <> 'succeeded')) LIMIT 1`,
        )
        .get(runId);
      if (isTruthy(unresolved)) return null;
      const dispatchGeneration = optionalString(
        sqlite
          .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
          .get(runId)?.generation,
      );
      if (sourceGeneration !== undefined && dispatchGeneration === undefined) return null;
      if (sourceGeneration === undefined)
        return {
          runId,
          workflowRevisionId: bound.workflow_revision_id,
          dispatchGeneration: dispatchGeneration ?? null,
        };
      const durableExecutionId = optionalString(
        sqlite
          .prepare(
            `SELECT execution_id FROM owner_workflow_executions
             WHERE workflow_name = 'GoalExecution' AND status = 'completed'
               AND json_extract(payload_json, '$.identity.sessionId') = ?
               AND json_extract(payload_json, '$.identity.runId') = ?
               AND json_extract(payload_json, '$.identity.goalInstanceId') = ?
               AND json_extract(payload_json, '$.identity.workflowRevisionId') = ?
               AND json_extract(result_json, '$._tag') = 'Complete'
               AND json_extract(result_json, '$.exit._tag') = 'Success'
               AND json_extract(result_json, '$.exit.value._tag') = 'GoalExecutionSuccess'
               AND json_extract(result_json, '$.exit.value.runId') = ?
               AND json_extract(result_json, '$.exit.value.executionId') = execution_id`,
          )
          .get(sessionId, runId, goalId, bound.workflow_revision_id, runId)?.execution_id,
      );
      return durableExecutionId === undefined
        ? null
        : {
            runId,
            workflowRevisionId: bound.workflow_revision_id,
            dispatchGeneration: dispatchGeneration ?? null,
            durableExecutionId,
          };
    };
    const recorder = valid(recorderRunId);
    if (!(recorder !== null)) return { status: "refused" };
    const recorderProvenance = provenance(recorderRunId, recorder);
    if (recorderProvenance === null) return { status: "refused" };
    const runs = MutableHashMap.empty<string, typeof RunProvenance.Type>();
    MutableHashMap.set(runs, recorderRunId, recorderProvenance);
    const coverage = MutableHashSet.empty<number>();
    for (const mapping of mappings) {
      const step = plan.steps.find((candidate) => candidate.id === mapping.stepId);
      const bound = valid(mapping.runId);
      if (
        !(bound !== null) ||
        !isTruthy(step) ||
        step.status !== "completed" ||
        step.evidence.length === 0 ||
        mapping.outcomeIndex < 0 ||
        mapping.acceptanceIndex < 0 ||
        goal.outcomes[mapping.outcomeIndex] !== mapping.outcomeText ||
        step.acceptanceCriteria[mapping.acceptanceIndex] !== mapping.acceptanceText ||
        mapping.evidenceNodeIds.length === 0
      )
        return { status: "refused" };
      for (const nodeId of mapping.evidenceNodeIds) {
        const node = sqlite
          .prepare(`SELECT 1 FROM nodes WHERE id = ? AND session_id = ?
          AND project_id = ? AND run_id = ? AND kind = 'tool_result'
          AND json_extract(detail, '$.ok') = 1 AND length(trim(text)) > 0`)
          .get(nodeId, sessionId, projectId, mapping.runId);
        if (!isTruthy(node)) return { status: "refused" };
      }
      MutableHashSet.add(coverage, mapping.outcomeIndex);
      const runProvenance = provenance(mapping.runId, bound);
      if (runProvenance === null) return { status: "refused" };
      MutableHashMap.set(runs, mapping.runId, runProvenance);
    }
    if (MutableHashSet.size(coverage) !== goal.outcomes.length) return { status: "refused" };
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    const registration = EffectFunction.flow(
      Schema.decodeUnknownResult(Schema.UndefinedOr(Registration)),
      Result.getOrThrow,
    )(
      sqlite
        .prepare(`SELECT artifact_hash AS artifactHash, source_hash AS sourceHash,
        contract_version AS contractVersion FROM workflow_goal_native_artifacts
        WHERE goal_instance_id = ?`)
        .get(goalId),
    );
    return {
      status: "accepted",
      snapshot: {
        sessionId,
        projectId,
        goalInstanceId: goalId,
        goalVersion: goal.version,
        planVersion: plan.version,
        recorderRunId,
        recorderRevisionId: recorder.workflow_revision_id,
        sourceGeneration: sourceGeneration ?? null,
        manifestHash: optionalString(source?.manifest_hash) ?? null,
        nativeRegistration: registration ?? null,
        mappings,
        runs: [...MutableHashMap.values(runs)],
      },
    };
  };
  const running = (runId: string) =>
    sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId)?.status ===
    "running";
  return { required, derive, running };
}
