import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Function as EffectFunction,
  Layer,
  Random,
  Result,
  Schema,
} from "effect";
import { DurableClock, Workflow, WorkflowEngine } from "effect/workflow";
import { RequestNotSent } from "../oauth/protocol.ts";
import { ExecutionAdmission } from "../runtime/execution-admission.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import { WorkflowExecution } from "./execution.ts";
import { ownerWorkflowEngineLayer } from "./owner-workflow-engine.ts";
import { OwnerWorkflowStorage, OwnerWorkflowStorageError } from "./owner-workflow-storage.ts";

/**
 * Backoff and exhaustion of a provider request that was never sent. One place for every limit;
 * the decided values and their reasons are in docs/decisions.md (2026-10-13).
 */
export const providerRetryLimits = {
  initialDelayMs: 2_000,
  maxDelayMs: Duration.toMillis(Duration.minutes(30)),
  /** Each wait is scaled by a random factor in [1 - jitter, 1 + jitter], then capped. */
  jitter: 0.2,
  /** Waits for one provider request before it stops behind a blocker. */
  maxRetries: 20,
  /** From the request's first failure to the latest retry time. */
  maxElapsedMs: Duration.toMillis(Duration.hours(24)),
} as const;

const Identifier = Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()));
const Stage = RequestNotSent.fields.stage;
export type ProviderRetryStage = typeof Stage.Type;

/**
 * `retryAt` is computed once by the owner before admission and stored with the execution. Replay
 * reads it back; the workflow body never recomputes it.
 */
const ProviderRetryWaitPayload = Schema.Struct({
  sessionId: Identifier,
  runId: Identifier,
  /** Order of this wait among every provider retry of the run. */
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Consecutive retries of the current provider request, starting at 1. */
  retry: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  stage: Stage,
  firstFailedAt: Schema.Finite,
  retryAt: Schema.Finite,
});
type ProviderRetryWaitPayload = typeof ProviderRetryWaitPayload.Type;

const RetryKey = Schema.Tuple([Identifier, Schema.Int]);
const encodeRetryKey = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(RetryKey)),
  Result.getOrThrow,
);

/**
 * Stable key of one retry wait: the run (one Goal run is one attempt) and the wait's order in it.
 * Neither time, randomness nor a process-local counter takes part.
 */
export const providerRetryIdempotencyKey = (runId: string, sequence: number) =>
  `provider-retry-v1-${sha256(encodeRetryKey([runId, sequence]))}`;

const ProviderRetryWait = Workflow.make("ProviderRetryWait", {
  payload: ProviderRetryWaitPayload,
  idempotencyKey: ({ runId, sequence }) => providerRetryIdempotencyKey(runId, sequence),
});

const waitHandler = (payload: ProviderRetryWaitPayload) =>
  Effect.gen(function* () {
    // The stored clock keeps its first due time, which is `retryAt`; replay only re-arms it.
    const remaining = payload.retryAt - (yield* Clock.currentTimeMillis);
    yield* DurableClock.sleep({
      name: "ProviderRetry/Wait",
      duration: Duration.millis(Math.max(0, remaining)),
      inMemoryThreshold: Duration.zero,
    });
  });

/** The next delay before jitter: 2s, doubling, never above the single-wait limit. */
export const providerRetryDelay = (retry: number) =>
  Math.min(providerRetryLimits.initialDelayMs * 2 ** (retry - 1), providerRetryLimits.maxDelayMs);

export type ProviderRetryOutcome =
  | { readonly _tag: "Retry" }
  /** Limits reached; the run's continuation is blocked with the reason. */
  | { readonly _tag: "Exhausted" }
  /** The owner cancelled the run while it waited. */
  | { readonly _tag: "Cancelled" };

export interface ProviderRetryRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly retry: number;
  readonly stage: ProviderRetryStage;
  readonly firstFailedAt: number;
}

/** A wait still pending, for the session's run state. */
export interface ProviderRetryView {
  readonly runId: string;
  readonly retry: number;
  readonly retryAt: number;
}

const storageFailure = (operation: string) => (cause: unknown) =>
  Schema.is(OwnerWorkflowStorageError)(cause)
    ? cause
    : OwnerWorkflowStorageError.make({ operation, reason: "database", cause });

const make = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const storage = yield* OwnerWorkflowStorage;
  const admission = yield* ExecutionAdmission;
  const execution = yield* WorkflowExecution;
  const provideEngine = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
    Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine);

  const stored = (pendingOnly: boolean) =>
    Effect.try({
      try: () =>
        pendingOnly
          ? storage.pendingExecutions(ProviderRetryWait._tag)
          : storage.workflowExecutions(ProviderRetryWait._tag),
      catch: storageFailure("provider_retry.list"),
    }).pipe(
      Effect.map((executions) =>
        executions.flatMap((entry) => {
          const decoded = Schema.decodeUnknownResult(ProviderRetryWaitPayload)(entry.payload);
          return Result.isSuccess(decoded) ? [decoded.success] : [];
        }),
      ),
    );

  /** Joins a wait; an interrupted wait reports cancellation instead of a durable failure. */
  const join = (payload: ProviderRetryWaitPayload) =>
    provideEngine(ProviderRetryWait.execute(payload)).pipe(
      Effect.as<ProviderRetryOutcome>({ _tag: "Retry" }),
      Effect.catchCauseIf(Cause.hasInterrupts, () =>
        Effect.succeed<ProviderRetryOutcome>({ _tag: "Cancelled" }),
      ),
    );

  const interrupt = (payload: ProviderRetryWaitPayload) =>
    ProviderRetryWait.executionId(payload).pipe(
      Effect.flatMap((executionId) => provideEngine(ProviderRetryWait.interrupt(executionId))),
    );

  return {
    /**
     * Persists the next wait for a provider request that was never sent and waits for it. The wait
     * is admitted through the workflow gate like a Goal execution; it holds no model permit.
     * Cancelling `signal` interrupts the workflow and removes its timer.
     */
    wait: (
      request: ProviderRetryRequest,
      signal: AbortSignal,
      changed: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        if (signal.aborted) return { _tag: "Cancelled" } as const;
        const now = yield* Clock.currentTimeMillis;
        const factor = 1 + ((yield* Random.next) * 2 - 1) * providerRetryLimits.jitter;
        const retryAt =
          now +
          Math.round(
            Math.min(providerRetryDelay(request.retry) * factor, providerRetryLimits.maxDelayMs),
          );
        if (
          request.retry > providerRetryLimits.maxRetries ||
          retryAt - request.firstFailedAt > providerRetryLimits.maxElapsedMs
        ) {
          yield* execution.block(request.sessionId, request.runId, {
            reason: "external_dependency",
            detail:
              "공급자에 요청을 보내지 못하는 상태가 이어져 자동 재시도를 멈췄어요. 네트워크와 공급자 연결을 확인한 뒤 다시 보내 주세요.",
            evidence: [
              request.runId,
              `provider_request_not_sent:${request.stage}`,
              `retries:${request.retry - 1}`,
            ],
          });
          yield* changed;
          return { _tag: "Exhausted" } as const;
        }
        const runWaits = (yield* stored(false)).filter((entry) => entry.runId === request.runId);
        const payload: ProviderRetryWaitPayload = {
          sessionId: request.sessionId,
          runId: request.runId,
          sequence: runWaits.length,
          retry: request.retry,
          stage: request.stage,
          firstFailedAt: request.firstFailedAt,
          retryAt,
        };
        yield* admission.run(
          "workflow",
          provideEngine(ProviderRetryWait.execute(payload, { discard: true })),
        );
        yield* changed;
        const cancel = Effect.callback<void>((resume) => {
          const onAbort = () => resume(Effect.void);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          return Effect.sync(() => signal.removeEventListener("abort", onAbort));
        }).pipe(
          Effect.andThen(interrupt(payload)),
          Effect.as<ProviderRetryOutcome>({ _tag: "Cancelled" }),
        );
        return yield* Effect.raceFirst(join(payload), cancel).pipe(Effect.ensuring(changed));
      }),

    /** Waits still pending in a session, oldest first. */
    pending: (sessionId: string) =>
      stored(true).pipe(
        Effect.map((waits) =>
          waits
            .filter((entry) => entry.sessionId === sessionId)
            .sort((left, right) => left.retryAt - right.retryAt)
            .map((entry): ProviderRetryView => ({
              runId: entry.runId,
              retry: entry.retry,
              retryAt: entry.retryAt,
            })),
        ),
      ),

    /**
     * After a restart, waits until the run's pending wait fires. Returns at once when none is
     * pending, and reports cancellation when the owner interrupts it meanwhile.
     */
    awaitRun: (runId: string) =>
      Effect.gen(function* () {
        const pending = (yield* stored(true)).filter((entry) => entry.runId === runId);
        for (const payload of pending) {
          const outcome = yield* join(payload);
          if (outcome._tag === "Cancelled") return outcome;
        }
        return { _tag: "Retry" } as const;
      }),

    /** Owner cancellation of every pending wait in the session; never a durable failure. */
    cancelSession: (sessionId: string) =>
      stored(true).pipe(
        Effect.flatMap((waits) =>
          Effect.forEach(
            waits.filter((entry) => entry.sessionId === sessionId),
            interrupt,
            { discard: true },
          ),
        ),
      ),
  };
});

/** Durable waits between retries of a provider request that never reached the provider. */
export class ProviderRetries extends Context.Service<
  ProviderRetries,
  Effect.Success<typeof make>
>()("memory-agent/workflow/provider-retry/ProviderRetries") {}

export const providerRetryLayer = Layer.merge(
  Layer.effect(ProviderRetries, make),
  ProviderRetryWait.toLayer(waitHandler),
).pipe(Layer.provide(WorkflowExecution.layer), Layer.provideMerge(ownerWorkflowEngineLayer));
