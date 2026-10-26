import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Match,
  Option,
  PubSub,
  Schema,
  Semaphore,
} from "effect";
import { PersistedQueue } from "effect/persistence";
import { DurableQueue, Workflow } from "effect/workflow";
import { kanbanConcurrencyLimit, type GlobalConfigFailed } from "../config/global-config.ts";
import { KanbanSettings } from "../config/kanban-settings.ts";
import { Workflows } from "../workflow/workflow.ts";
import { CardAgent, type CardAgentOutcome } from "./card-agent.ts";
import {
  CardAttemptOutcome,
  CardAttempts,
  KanbanStorageFailed,
  KanbanStorageReason,
  type CardAttemptKey,
} from "./card-attempts.ts";
import { cardWorkspace, CardWorktrees } from "./worktree.ts";
import { CardFailure, worktreeFailure } from "./failures.ts";

/**
 * Kanban card assignment on DurableQueue (docs/kanban-orchestration.md "큐: DurableQueue"). One
 * card attempt is one queue item keyed `goalInstanceId:cardId:attemptNo`; its
 * `KanbanCardAttempt` workflow only offers the item and waits for the worker's result. The
 * handler records the outcome itself, so the orchestrator reads results from the database and a
 * redelivered item whose outcome is already recorded returns it without running anything.
 */

export const CardRunPayload = Schema.Struct({
  sessionId: Schema.String,
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  /** Chosen by the owner from stored attempts, never from a process counter. */
  attemptNo: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The Goal and Plan versions fixed when the card was assigned. */
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  /** Changes applied to the card that this attempt must follow. */
  notes: Schema.Array(Schema.String),
});
export type CardRunPayload = typeof CardRunPayload.Type;

export const cardAttemptKey = (attempt: CardAttemptKey) =>
  `${attempt.goalInstanceId}:${attempt.cardId}:${attempt.attemptNo}`;

export const CardQueue = DurableQueue.make({
  name: "KanbanCard",
  payload: CardRunPayload,
  success: CardAttemptOutcome,
  error: KanbanStorageFailed,
  idempotencyKey: cardAttemptKey,
});

/** The PersistedQueue name DurableQueue gives the card queue; dead letters are read by it. */
export const cardQueueName = `DurableQueue/${CardQueue.name}`;

/**
 * Deliveries of one card attempt before its item is dead-lettered (docs: 카드당 최대 시도 수 3). A
 * handler's own failure completes the attempt instead of retrying it, so deliveries are spent by
 * crashes and by failures to record the result.
 */
export const cardDeliveryLimit = 3;

/** The durable waiter of one card attempt. Replaying it re-offers nothing: the item id is stable. */
export const CardAttemptExecution = Workflow.make("KanbanCardAttempt", {
  payload: CardRunPayload.fields,
  success: CardAttemptOutcome,
  error: KanbanStorageFailed,
  idempotencyKey: cardAttemptKey,
});

/**
 * Cards that may run at once across every Goal. The card queue takes an item only while holding a
 * permit, so a resize changes how many run without interrupting any. Every saved concurrency
 * change resizes it.
 */
export class CardQueueGate extends Context.Service<
  CardQueueGate,
  {
    readonly semaphore: Semaphore.Semaphore;
    /** Applies the current concurrency setting to new takes. */
    readonly reconfigure: Effect.Effect<number, GlobalConfigFailed>;
  }
>()("memory-agent/kanban/card-queue/CardQueueGate") {
  static readonly layer = Layer.effect(
    CardQueueGate,
    Effect.gen(function* () {
      const settings = yield* KanbanSettings;
      const initial = (yield* settings.concurrency).effective;
      const semaphore = yield* Semaphore.make(initial);
      // Subscribed before the layer is built, so no change saved after it is missed.
      const changes = yield* settings.changes;
      yield* PubSub.take(changes).pipe(
        Effect.flatMap(({ effective }) => semaphore.resize(effective)),
        Effect.forever,
        Effect.forkScoped,
      );
      return CardQueueGate.of({
        semaphore,
        reconfigure: Effect.flatMap(settings.concurrency, ({ effective }) =>
          Effect.as(semaphore.resize(effective), effective),
        ),
      });
    }),
  );
}

/**
 * PersistedQueueFactory for the owner: the card queue gets its delivery limit and gate, other
 * queues are made as the store makes them.
 */
export const cardQueueFactoryLayer = Layer.effect(
  PersistedQueue.PersistedQueueFactory,
  Effect.gen(function* () {
    const factory = yield* PersistedQueue.makeFactory;
    const gate = yield* CardQueueGate;
    return PersistedQueue.PersistedQueueFactory.of({
      make: (options) =>
        options.name === cardQueueName
          ? Effect.map(factory.make({ ...options, maxAttempts: cardDeliveryLimit }), (queue) => ({
              ...queue,
              take: (f) => gate.semaphore.withPermits(1)(queue.take(f)),
            }))
          : factory.make(options),
    });
  }),
);

/** Agent runs of executing cards, so the orchestrator can stop one without touching its item. */
export class CardRuns extends Context.Service<
  CardRuns,
  {
    readonly running: FiberMap.FiberMap<string, CardAgentOutcome>;
    /** Stops a card's agent; its delivery then completes as `Stopped`. */
    readonly stop: (goalInstanceId: string, cardId: string) => Effect.Effect<void>;
  }
>()("memory-agent/kanban/card-queue/CardRuns") {
  static readonly layer = Layer.effect(
    CardRuns,
    Effect.gen(function* () {
      const running = yield* FiberMap.make<string, CardAgentOutcome>();
      return CardRuns.of({
        running,
        stop: (goalInstanceId, cardId) => FiberMap.remove(running, `${goalInstanceId}:${cardId}`),
      });
    }),
  );
}

const failedWith = (failure: CardFailure): CardAttemptOutcome =>
  CardAttemptOutcome.cases.Failed.make({ failure });

/** Runs one delivery after the checks that keep it from replaying or running a stale card. */
const deliver = Effect.fnUntraced(function* (payload: CardRunPayload) {
  const attempts = yield* CardAttempts;
  const workflows = yield* Workflows;
  const worktrees = yield* CardWorktrees;
  const agent = yield* CardAgent;
  const runs = yield* CardRuns;
  const key = payload satisfies CardAttemptKey;

  // A new Goal instance took over the session: an earlier instance's card never runs.
  if ((yield* workflows.goalInstanceId(payload.sessionId)) !== payload.goalInstanceId)
    return CardAttemptOutcome.cases.Superseded.make({});
  const goal = yield* attempts.goal(payload.goalInstanceId);
  const card = (yield* workflows.get(payload.sessionId)).plan?.steps.find(
    (step) => step.id === payload.cardId,
  );
  if (Option.isNone(goal) || !goal.value.active || card?.status !== "in_progress")
    return CardAttemptOutcome.cases.Stopped.make({ cardStatus: card?.status ?? null });
  const fenced = yield* attempts.fencedRun(payload.goalInstanceId, payload.cardId);
  if (Option.isSome(fenced)) return CardAttemptOutcome.cases.Fenced.make({ runId: fenced.value });
  const continuation = yield* attempts.hasRuns(payload.goalInstanceId, payload.cardId);
  const { generation } = yield* attempts.ladder(payload.goalInstanceId, payload.cardId);
  const cardRef = {
    projectRoot: goal.value.projectRoot,
    goalInstanceId: payload.goalInstanceId,
    cardId: payload.cardId,
  };
  const workspace = cardWorkspace(worktrees, goal.value.mode);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const worktree = yield* workspace.lease(cardRef);
      const fiber = yield* FiberMap.run(
        runs.running,
        `${payload.goalInstanceId}:${payload.cardId}`,
        agent.run({
          sessionId: payload.sessionId,
          projectId: goal.value.projectId,
          goalInstanceId: payload.goalInstanceId,
          card,
          attemptNo: payload.attemptNo,
          worktree,
          continuation,
          notes: payload.notes,
          generation,
          register: (run) => attempts.registerRun(key, run),
        }),
      );
      // The agent lives in the service's FiberMap; this delivery ending early stops it too.
      const exit = yield* Fiber.await(fiber).pipe(
        Effect.onInterrupt(() =>
          FiberMap.remove(runs.running, `${payload.goalInstanceId}:${payload.cardId}`),
        ),
      );
      return yield* Exit.match(exit, {
        // The orchestrator stopping the agent interrupts it; anything else that ends it is a failure.
        onFailure: (cause) =>
          Effect.succeed(
            Cause.hasInterruptsOnly(cause)
              ? CardAttemptOutcome.cases.Stopped.make({ cardStatus: "in_progress" })
              : failedWith(CardFailure.cases.Defect.make({})),
          ),
        onSuccess: Match.valueTags({
          Failed: ({ failure }) => Effect.succeed(failedWith(failure)),
          // The card's agent cannot write the repository's git metadata from its sandbox; the owner
          // commits its work to the card branch.
          Finished: ({ report }) =>
            Effect.map(
              workspace.commitWork(cardRef, `${card.title}\n\nattempt ${payload.attemptNo}`),
              (commit) =>
                CardAttemptOutcome.cases.Completed.make({
                  report,
                  commit: Option.getOrNull(commit),
                }),
            ),
        }),
      });
    }),
  ).pipe(
    Effect.catchTag("CardWorktreeFailed", (failure) =>
      failure.pipe(worktreeFailure, failedWith, Effect.succeed),
    ),
  );
});

/**
 * The queue handler. An item redelivered after its outcome was recorded returns that outcome; any
 * other delivery continues the card in its worktree as a new run.
 */
export const handleCardRun = Effect.fn("CardQueue.handle")(function* (payload: CardRunPayload) {
  const attempts = yield* CardAttempts;
  const recorded = yield* attempts.attempt(payload);
  return yield* Option.match(
    Option.flatMapNullishOr(recorded, (attempt) => attempt.outcome),
    {
      onSome: Effect.succeed,
      onNone: () =>
        deliver(payload).pipe(
          Effect.catchTag("WorkflowStorageError", (cause) =>
            Effect.fail(
              KanbanStorageFailed.make({
                operation: "card",
                reason: KanbanStorageReason.cases.Storage.make({}),
                cause,
              }),
            ),
          ),
          Effect.tap((outcome) => attempts.recordOutcome(payload, outcome)),
        ),
    },
  );
});

/**
 * Takers of the card queue. There are as many as the largest concurrency setting; the gate's
 * permits decide how many hold an item.
 */
export const cardQueueWorkerLayer = DurableQueue.worker(CardQueue, handleCardRun, {
  concurrency: kanbanConcurrencyLimit,
});

/** Registers the card attempt workflow: offer the item and wait for its result. */
export const cardAttemptExecutionLayer = CardAttemptExecution.toLayer((payload) =>
  DurableQueue.process(CardQueue, payload),
);
