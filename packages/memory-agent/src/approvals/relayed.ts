import { randomUUID } from "../runtime/synchronous-crypto.ts";
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { ownerWorkflowEngineLayer } from "../workflow/owner-workflow-engine.ts";
import { OwnerWorkflowStorage } from "../workflow/owner-workflow-storage.ts";
import type { RelayedApprovalView } from "./relayed-state.ts";

const ApprovalRequester = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("subagent"),
    subagentId: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("external_agent"), agent: Schema.String }),
]);

const RelayedApprovalPayload = Schema.Struct({
  approvalId: Schema.String,
  sessionId: Schema.String,
  runId: Schema.String,
  requester: ApprovalRequester,
  toolName: Schema.String,
  argumentsJson: Schema.String,
  reason: Schema.String,
  askedBy: Schema.Literals(["review", "every_call", "agent"]),
  createdAt: Schema.Finite,
  timeoutMs: Schema.Finite,
});
type RelayedApprovalPayload = typeof RelayedApprovalPayload.Type;

const RelayedApprovalOutcome = Schema.Union([
  Schema.TaggedStruct("Answered", { approved: Schema.Boolean }),
  Schema.TaggedStruct("TimedOut", {}),
]);
type RelayedApprovalOutcome = typeof RelayedApprovalOutcome.Type;

const RelayedApprovalExecution = Workflow.make("RelayedApprovalExecution", {
  payload: RelayedApprovalPayload,
  success: RelayedApprovalOutcome,
  idempotencyKey: ({ sessionId, runId, approvalId }) =>
    `${sessionId}\u0000${runId}\u0000${approvalId}`,
});

const RelayedApprovalDecision = DurableDeferred.make("RelayedApproval/Decision", {
  success: Schema.Boolean,
});

const approvalHandler = (payload: RelayedApprovalPayload) =>
  DurableDeferred.raceAll({
    name: "RelayedApproval/DecisionOrTimeout",
    success: RelayedApprovalOutcome,
    error: Schema.Never,
    effects: [
      DurableDeferred.await(RelayedApprovalDecision).pipe(
        Effect.map((approved) => ({ _tag: "Answered" as const, approved })),
      ),
      DurableClock.sleep({
        name: "RelayedApproval/Timeout",
        duration: Duration.millis(payload.timeoutMs),
        inMemoryThreshold: Duration.zero,
      }).pipe(Effect.as({ _tag: "TimedOut" as const })),
    ],
  });

export type RelayedRequest = Omit<RelayedApprovalView, "id" | "createdAt">;

const payloadView = (payload: RelayedApprovalPayload): RelayedApprovalView => ({
  id: payload.approvalId,
  requester: payload.requester,
  toolName: payload.toolName,
  argumentsJson: payload.argumentsJson,
  reason: payload.reason,
  askedBy: payload.askedBy,
  createdAt: payload.createdAt,
});

const make = (timeoutMs: number) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const storage = yield* OwnerWorkflowStorage;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const provideEngine = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
      Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine);

    const find = (sessionId: string, approvalId: string) =>
      Effect.map(
        storage.workflowExecutions(RelayedApprovalExecution._tag),
        (executions) =>
          executions.flatMap((execution) => {
            const decoded = Schema.decodeUnknownResult(RelayedApprovalPayload)(execution.payload);
            return Result.isSuccess(decoded) &&
              decoded.success.sessionId === sessionId &&
              decoded.success.approvalId === approvalId
              ? [{ execution, payload: decoded.success }]
              : [];
          })[0],
      );

    return {
      /**
       * Persists the approval wait as an Effect Workflow execution. Owner cancellation interrupts
       * that execution; process/layer restart without cancellation preserves the pending race.
       */
      ask: (
        sessionId: string,
        runId: string,
        request: RelayedRequest,
        signal: AbortSignal,
      ): Promise<boolean> => {
        if (signal.aborted) return Promise.resolve(false);
        return runPromise(
          Effect.gen(function* () {
            const payload: RelayedApprovalPayload = {
              ...request,
              approvalId: randomUUID(),
              sessionId,
              runId,
              createdAt: yield* Clock.currentTimeMillis,
              timeoutMs,
            };
            const executionId = yield* RelayedApprovalExecution.executionId(payload);
            const execute = provideEngine(RelayedApprovalExecution.execute(payload)).pipe(
              Effect.map((outcome) => outcome._tag === "Answered" && outcome.approved),
              Effect.catchCauseIf(Cause.hasInterrupts, () => Effect.succeed(false)),
            );
            const cancel = Effect.callback<void>((resume) => {
              const onAbort = () => resume(Effect.void);
              signal.addEventListener("abort", onAbort, { once: true });
              return Effect.sync(() => signal.removeEventListener("abort", onAbort));
            }).pipe(
              Effect.andThen(provideEngine(RelayedApprovalExecution.interrupt(executionId))),
              Effect.as(false),
            );
            return yield* Effect.raceFirst(execute, cancel);
          }),
        );
      },

      pending: (sessionId: string) =>
        Effect.map(storage.pendingExecutions(RelayedApprovalExecution._tag), (executions) =>
          executions
            .flatMap((execution) => {
              const decoded = Schema.decodeUnknownResult(RelayedApprovalPayload)(execution.payload);
              return Result.isSuccess(decoded) && decoded.success.sessionId === sessionId
                ? [payloadView(decoded.success)]
                : [];
            })
            .toSorted((left, right) => left.createdAt - right.createdAt),
        ),

      /** False for a foreign, timed-out or unknown approval. Same-value duplicates are idempotent. */
      answer: (sessionId: string, approvalId: string, approved: boolean) =>
        Effect.gen(function* () {
          const found = yield* find(sessionId, approvalId);
          if (found === undefined) return false;
          const { execution, payload } = found;
          const stored = yield* storage.deferredResult(
            execution.executionId,
            RelayedApprovalDecision.name,
          );
          if (Option.isSome(stored)) {
            const decoded = Schema.decodeUnknownResult(
              Schema.TaggedStruct("Success", { value: Schema.Boolean }),
            )(stored.value);
            return Result.isSuccess(decoded) && decoded.success.value === approved;
          }
          if (execution.status === "completed" || execution.status === "interrupted") return false;
          const token = DurableDeferred.tokenFromExecutionId(RelayedApprovalDecision, {
            workflow: RelayedApprovalExecution,
            executionId: execution.executionId,
          });
          yield* provideEngine(
            DurableDeferred.succeed(RelayedApprovalDecision, { token, value: approved }),
          );
          yield* provideEngine(RelayedApprovalExecution.execute(payload)).pipe(Effect.result);
          return true;
        }),
    };
  });

/** Approval requests relayed to the page from work that runs inside a tool call. */
export class RelayedApprovals extends Context.Service<
  RelayedApprovals,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/approvals/relayed/RelayedApprovals") {
  static readonly layerWith = (options?: { readonly timeoutMs?: number }) => {
    const timeoutMs = options?.timeoutMs ?? Duration.toMillis(Duration.days(1));
    const service = Layer.effect(RelayedApprovals, make(timeoutMs));
    const handler = RelayedApprovalExecution.toLayer(approvalHandler);
    return Layer.merge(service, handler).pipe(Layer.provideMerge(ownerWorkflowEngineLayer));
  };

  static readonly layer = RelayedApprovals.layerWith();
}
