import { Context, Effect, Exit, Layer, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import {
  AdmissionWait,
  ExecutionAdmission,
  type ExecutionSaturated,
} from "../runtime/execution-admission.ts";
import { Admission, type RunBinding } from "./run-bindings.ts";
import {
  GoalExecutionError,
  GoalExecutionPayload,
  GoalExecutionSuccess,
  goalExecutionIdempotencyKey,
  type GoalExecutionErrorReason,
  type GoalExecutionPayload as GoalExecutionPayloadType,
} from "./goal-execution-contracts.ts";
import { ownerWorkflowEngineLayer } from "./owner-workflow-engine.ts";
import {
  OwnerWorkflowAdmission,
  OwnerWorkflowStorage,
  OwnerWorkflowStorageError,
  type OwnerWorkflowAdmissionResult,
} from "./owner-workflow-storage.ts";

export class GoalExecutionAdmissionRefused extends Schema.TaggedError<GoalExecutionAdmissionRefused>()(
  "GoalExecutionAdmissionRefused",
  {
    reason: Schema.Literals([
      "legacy_unbound",
      "workflow_changed",
      "run_id_conflict",
      "run_outcome_uncertain",
      "owner_mismatch",
    ]),
  },
) {}

const goalExecutionWorkflow = "GoalExecution";

/** The durable runtime envelope around one owner-bound Goal SDK run. */
export const GoalExecution = Workflow.make(goalExecutionWorkflow, {
  payload: GoalExecutionPayload,
  success: GoalExecutionSuccess,
  error: GoalExecutionError,
  idempotencyKey: ({ identity }) => goalExecutionIdempotencyKey(identity),
});

/**
 * The SDK loop remains an owner-ledger operation. It completes this wait point exactly once;
 * replaying the workflow body never invokes the model or a tool again.
 */
export const GoalExecutionCompletion = DurableDeferred.make("GoalExecution/Completion", {
  success: GoalExecutionSuccess,
  error: GoalExecutionError,
});

const handler = (_payload: GoalExecutionPayloadType) =>
  DurableDeferred.await(GoalExecutionCompletion);

const make = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const admission = yield* OwnerWorkflowAdmission;
  const storage = yield* OwnerWorkflowStorage;
  const executionAdmission = yield* ExecutionAdmission;
  const provideEngine = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
    Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine);

  const token = (executionId: string) =>
    DurableDeferred.tokenFromExecutionId(GoalExecutionCompletion, {
      workflow: GoalExecution,
      executionId,
    });

  return {
    /** Admitted executions still waiting for their run to settle them, as their stored payloads. */
    unsettled: storage
      .pendingExecutions(goalExecutionWorkflow)
      .pipe(
        Effect.flatMap((executions) =>
          Effect.forEach(executions, (execution) =>
            Schema.decodeUnknownEffect(GoalExecutionPayload)(execution.payload),
          ),
        ),
      ),

    /**
     * Commits the existing owner run binding callback and first durable request together, then
     * dispatches the replay-safe workflow body. A committed request is always re-identifiable.
     */
    admitAndStart: <E>(
      payload: GoalExecutionPayloadType,
      bind: Effect.Effect<Admission, E>,
    ): Effect.Effect<
      OwnerWorkflowAdmissionResult<RunBinding>,
      GoalExecutionAdmissionRefused | OwnerWorkflowStorageError | ExecutionSaturated | E
    > =>
      executionAdmission.run(
        "workflow",
        Effect.gen(function* () {
          const executionId = yield* GoalExecution.executionId(payload);
          const admitted = yield* admission
            .admit(
              {
                workflowName: goalExecutionWorkflow,
                executionId,
                payload,
              },
              Effect.flatMap(
                bind,
                Admission.$match({
                  bound: ({ binding }) => Effect.succeed(binding),
                  refused: ({ reason }) =>
                    Effect.fail(GoalExecutionAdmissionRefused.make({ reason })),
                }),
              ),
            )
            .pipe(
              Effect.catchIf(
                (error) =>
                  Schema.is(OwnerWorkflowStorageError)(error) &&
                  error.reason === "execution_conflict",
                () => Effect.fail(GoalExecutionAdmissionRefused.make({ reason: "owner_mismatch" })),
              ),
            );
          yield* provideEngine(GoalExecution.execute(payload, { discard: true }));
          return admitted;
        }),
        // A request is waiting on this: past half a minute it is told the app is busy.
        AdmissionWait.upTo({ duration: "30 seconds" }),
      ),

    succeed: (payload: GoalExecutionPayloadType) =>
      Effect.gen(function* () {
        const executionId = yield* GoalExecution.executionId(payload);
        yield* provideEngine(
          DurableDeferred.succeed(GoalExecutionCompletion, {
            token: token(executionId),
            value: GoalExecutionSuccess.make({
              executionId,
              runId: payload.identity.runId,
              outcome: "completed",
            }),
          }),
        );
        yield* provideEngine(GoalExecution.execute(payload)).pipe(Effect.result);
      }),

    fail: (payload: GoalExecutionPayloadType, reason: GoalExecutionErrorReason) =>
      Effect.gen(function* () {
        const executionId = yield* GoalExecution.executionId(payload);
        yield* provideEngine(
          DurableDeferred.done(GoalExecutionCompletion, {
            token: token(executionId),
            exit: Exit.fail(
              GoalExecutionError.make({
                executionId,
                reason,
              }),
            ),
          }),
        );
        yield* provideEngine(GoalExecution.execute(payload)).pipe(Effect.result);
      }),
  };
});

export class GoalExecutions extends Context.Service<GoalExecutions, Effect.Success<typeof make>>()(
  "memory-agent/workflow/goal-execution/GoalExecutions",
) {}

const goalExecutionServiceLayer = Layer.effect(GoalExecutions, make);
const goalExecutionHandlerLayer = GoalExecution.toLayer(handler);

/** One app-lifetime graph: owner engine/storage/admission, workflow registration and client API. */
export const goalExecutionLayer = Layer.merge(
  goalExecutionServiceLayer,
  goalExecutionHandlerLayer,
).pipe(Layer.provideMerge(ownerWorkflowEngineLayer));
