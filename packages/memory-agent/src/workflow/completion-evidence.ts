import { isTruthy } from "../truthy.ts";
import { Data, Effect, MutableHashMap, MutableHashSet, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
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
const Registration = Schema.Struct({
  artifactHash: Schema.String,
  sourceHash: Schema.String,
  contractVersion: Schema.String,
});
const Run = Schema.Struct({ thread_id: Schema.String, status: Schema.String });
const Revision = Schema.Struct({
  session_id: Schema.String,
  goal_instance_id: Schema.NullOr(Schema.String),
  goal_version: Schema.NullOr(Schema.Int),
  plan_version: Schema.NullOr(Schema.Int),
});
const Source = Schema.Struct({ source_generation: Schema.String, manifest_hash: Schema.String });

export type Derived = Data.TaggedEnum<{
  accepted: { readonly snapshot: CompletionSnapshot };
  refused: {};
}>;
export const Derived = Data.taggedEnum<Derived>();
const refused: Derived = Derived.refused();

/** Owner-side DB boundary; no code, credentials or artifact bytes enter the snapshot. */
export const completionEvidence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const goalIdentity = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ goal_instance_id: Schema.String }),
    execute: (sessionId) =>
      sql`SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}`,
  });
  const identity = (sessionId: string) =>
    goalIdentity(sessionId).pipe(
      Effect.map(Option.map((row) => row.goal_instance_id)),
      Effect.map(Option.getOrUndefined),
    );
  const exists = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
    Effect.map(statement, (rows) => rows.length > 0);
  const required = Effect.fnUntraced(function* (sessionId: string) {
    const id = yield* identity(sessionId);
    return (
      id !== undefined &&
      (yield* exists(
        sql`SELECT 1 FROM workflow_goal_native_artifacts WHERE goal_instance_id = ${id}
          UNION ALL SELECT 1 FROM workflow_goal_worker_generations WHERE goal_instance_id = ${id}
          LIMIT 1`,
      ))
    );
  });
  const projectOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ project_id: Schema.String }),
    execute: (sessionId) => sql`SELECT project_id FROM sessions WHERE id = ${sessionId}`,
  });
  const sourceOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Source,
    execute: (goalId) => sql`SELECT source_generation, manifest_hash
      FROM workflow_goal_worker_generations WHERE goal_instance_id = ${goalId}`,
  });
  const bindingOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Binding,
    execute: (runId) => sql`SELECT session_id, goal_instance_id, goal_version, plan_version,
      workflow_revision_id FROM workflow_run_bindings WHERE run_id = ${runId}`,
  });
  const runOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Run,
    execute: (runId) => sql`SELECT thread_id, status FROM chat_runs WHERE run_id = ${runId}`,
  });
  const revisionOf = SqlSchema.findOneOption({
    Request: Schema.Finite,
    Result: Revision,
    execute: (id) => sql`SELECT session_id, goal_instance_id, goal_version, plan_version
      FROM workflow_state_revisions WHERE id = ${id}`,
  });
  const dispatchOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ generation: Schema.String }),
    execute: (runId) =>
      sql`SELECT generation FROM workflow_worker_dispatches WHERE run_id = ${runId}`,
  });
  const dispatchGenerationOf = (runId: string) =>
    dispatchOf(runId).pipe(
      Effect.map(Option.map((row) => row.generation)),
      Effect.map(Option.getOrUndefined),
    );
  const durableExecutionOf = SqlSchema.findOneOption({
    Request: Schema.Struct({
      sessionId: Schema.String,
      runId: Schema.String,
      goalId: Schema.String,
      revisionId: Schema.Finite,
    }),
    Result: Schema.Struct({ execution_id: Schema.String }),
    execute: ({ sessionId, runId, goalId, revisionId }) => sql`SELECT execution_id
      FROM owner_workflow_executions
      WHERE workflow_name = 'GoalExecution' AND status = 'completed'
        AND json_extract(payload_json, '$.identity.sessionId') = ${sessionId}
        AND json_extract(payload_json, '$.identity.runId') = ${runId}
        AND json_extract(payload_json, '$.identity.goalInstanceId') = ${goalId}
        AND json_extract(payload_json, '$.identity.workflowRevisionId') = ${revisionId}
        AND json_extract(result_json, '$._tag') = 'Complete'
        AND json_extract(result_json, '$.exit._tag') = 'Success'
        AND json_extract(result_json, '$.exit.value._tag') = 'GoalExecutionSuccess'
        AND json_extract(result_json, '$.exit.value.runId') = ${runId}
        AND json_extract(result_json, '$.exit.value.executionId') = execution_id`,
  });
  const registrationOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Registration,
    execute: (goalId) => sql`SELECT artifact_hash AS artifactHash, source_hash AS sourceHash,
      contract_version AS contractVersion FROM workflow_goal_native_artifacts
      WHERE goal_instance_id = ${goalId}`,
  });
  const derive = Effect.fnUntraced(function* (
    sessionId: string,
    state: WorkflowState,
    mappings: readonly CriterionMapping[],
    recorderRunId: string,
    // Annotated: `fnUntraced` types an unannotated defaulted parameter as `any`.
    pendingRecorder: boolean = false,
  ) {
    const goal = state.goal;
    const plan = state.plan;
    const goalId = yield* identity(sessionId);
    const projectId = Option.getOrUndefined(yield* projectOf(sessionId))?.project_id;
    if (
      !isTruthy(goal) ||
      !isTruthy(plan) ||
      goalId === undefined ||
      projectId === undefined ||
      plan.goalVersion !== goal.version ||
      mappings.length === 0
    )
      return refused;
    const source = Option.getOrUndefined(yield* sourceOf(goalId));
    const sourceGeneration = source?.source_generation;
    const valid = Effect.fnUntraced(function* (runId: string) {
      const bound = Option.getOrUndefined(yield* bindingOf(runId));
      if (bound === undefined) return null;
      const run = Option.getOrUndefined(yield* runOf(runId));
      const revision = Option.getOrUndefined(yield* revisionOf(bound.workflow_revision_id));
      return run?.thread_id === sessionId &&
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
    });
    // A Goal worker's run names its dispatch; a run on the owner loop has none, even in a Goal a
    // worker ran before (decisions.md "Goal도 owner 프로세스에서 돌고 도구를 병렬로 실행한다 (2026-10-26)").
    const provenance = Effect.fnUntraced(function* (runId: string, bound: typeof Binding.Type) {
      const dispatchGeneration = (yield* dispatchGenerationOf(runId)) ?? null;
      if (pendingRecorder && runId === recorderRunId)
        return { runId, workflowRevisionId: bound.workflow_revision_id, dispatchGeneration };
      if (
        yield* exists(
          sql`SELECT 1 FROM owner_rpc_operations WHERE run_id = ${runId}
            AND (status = 'pending' OR (side_effect = 1 AND status <> 'succeeded')) LIMIT 1`,
        )
      )
        return null;
      if (sourceGeneration === undefined)
        return { runId, workflowRevisionId: bound.workflow_revision_id, dispatchGeneration };
      const durable = yield* durableExecutionOf({
        sessionId,
        runId,
        goalId,
        revisionId: bound.workflow_revision_id,
      });
      return Option.isNone(durable)
        ? null
        : {
            runId,
            workflowRevisionId: bound.workflow_revision_id,
            dispatchGeneration,
            durableExecutionId: durable.value.execution_id,
          };
    });
    const recorder = yield* valid(recorderRunId);
    if (recorder === null) return refused;
    const recorderProvenance = yield* provenance(recorderRunId, recorder);
    if (recorderProvenance === null) return refused;
    const runs = MutableHashMap.empty<string, typeof RunProvenance.Type>();
    MutableHashMap.set(runs, recorderRunId, recorderProvenance);
    const coverage = MutableHashSet.empty<number>();
    for (const mapping of mappings) {
      const step = plan.steps.find((candidate) => candidate.id === mapping.stepId);
      const bound = yield* valid(mapping.runId);
      if (
        bound === null ||
        !isTruthy(step) ||
        step.status !== "done" ||
        step.evidence.length === 0 ||
        mapping.outcomeIndex < 0 ||
        mapping.acceptanceIndex < 0 ||
        goal.outcomes[mapping.outcomeIndex] !== mapping.outcomeText ||
        step.acceptanceCriteria[mapping.acceptanceIndex] !== mapping.acceptanceText ||
        mapping.evidenceNodeIds.length === 0
      )
        return refused;
      for (const nodeId of mapping.evidenceNodeIds) {
        // A background receipt only says the work was accepted, not that it was done.
        const node = yield* exists(sql`SELECT 1 FROM nodes WHERE id = ${nodeId}
          AND session_id = ${sessionId} AND project_id = ${projectId} AND run_id = ${mapping.runId}
          AND kind = 'tool_result' AND json_extract(detail, '$.ok') = 1 AND length(trim(text)) > 0
          AND NOT coalesce(CASE WHEN json_valid(text) THEN json_extract(text, '$.taskId') IS NOT NULL
            AND coalesce(json_extract(text, '$.status'), '') NOT IN ('completed', 'succeeded') END, 0)`);
        if (!node) return refused;
      }
      MutableHashSet.add(coverage, mapping.outcomeIndex);
      const runProvenance = yield* provenance(mapping.runId, bound);
      if (runProvenance === null) return refused;
      MutableHashMap.set(runs, mapping.runId, runProvenance);
    }
    if (MutableHashSet.size(coverage) !== goal.outcomes.length) return refused;
    const registration = Option.getOrNull(yield* registrationOf(goalId));
    const accepted: Derived = Derived.accepted({
      snapshot: {
        sessionId,
        projectId,
        goalInstanceId: goalId,
        goalVersion: goal.version,
        planVersion: plan.version,
        recorderRunId,
        recorderRevisionId: recorder.workflow_revision_id,
        sourceGeneration: sourceGeneration ?? null,
        manifestHash: source?.manifest_hash ?? null,
        nativeRegistration: registration,
        mappings,
        runs: [...MutableHashMap.values(runs)],
      },
    });
    return accepted;
  });
  const running = (runId: string) =>
    runOf(runId).pipe(Effect.map(Option.exists((run) => run.status === "running")));
  return { required, derive, running };
});
