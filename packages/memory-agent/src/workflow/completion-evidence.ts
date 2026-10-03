import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
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

const Binding = Schema.Struct({
  session_id: Schema.String,
  goal_instance_id: Schema.String,
  goal_version: Schema.Int,
  plan_version: Schema.NullOr(Schema.Int),
  workflow_revision_id: Schema.Int,
});
const optionalBinding = Schema.decodeUnknownSync(Schema.UndefinedOr(Binding));
const Registration = Schema.Struct({
  artifactHash: Schema.String,
  sourceHash: Schema.String,
  contractVersion: Schema.String,
});

/** Owner-side DB boundary; no code, credentials or artifact bytes enter the snapshot. */
export function completionEvidence(sqlite: DatabaseSync) {
  const optionalString = Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.String));
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
      !goal ||
      !plan ||
      goalId === undefined ||
      projectId === undefined ||
      plan.goalVersion !== goal.version ||
      mappings.length === 0
    )
      return { status: "refused" };
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
      return bound &&
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
    const recorder = valid(recorderRunId);
    if (!recorder) return { status: "refused" };
    const runs = new Map<string, typeof RunProvenance.Type>();
    const recorderDispatch = sqlite
      .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
      .get(recorderRunId)?.generation;
    runs.set(recorderRunId, {
      runId: recorderRunId,
      workflowRevisionId: recorder.workflow_revision_id,
      dispatchGeneration: optionalString(recorderDispatch) ?? null,
    });
    const coverage = new Set<number>();
    for (const mapping of mappings) {
      const step = plan.steps.find((candidate) => candidate.id === mapping.stepId);
      const bound = valid(mapping.runId);
      if (
        !bound ||
        !step ||
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
        if (!node) return { status: "refused" };
      }
      coverage.add(mapping.outcomeIndex);
      const dispatch = sqlite
        .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
        .get(mapping.runId)?.generation;
      runs.set(mapping.runId, {
        runId: mapping.runId,
        workflowRevisionId: bound.workflow_revision_id,
        dispatchGeneration: optionalString(dispatch) ?? null,
      });
    }
    if (coverage.size !== goal.outcomes.length) return { status: "refused" };
    const source = sqlite
      .prepare(`SELECT source_generation, manifest_hash
      FROM workflow_goal_worker_generations WHERE goal_instance_id = ?`)
      .get(goalId);
    const registration = Schema.decodeUnknownSync(Schema.UndefinedOr(Registration))(
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
        sourceGeneration: optionalString(source?.source_generation) ?? null,
        manifestHash: optionalString(source?.manifest_hash) ?? null,
        nativeRegistration: registration ?? null,
        mappings,
        runs: [...runs.values()],
      },
    };
  };
  return { required, derive };
}
