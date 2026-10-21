import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { AppEvents } from "../events/app-events.ts";
import { KanbanStorageFailed } from "./card-attempts.ts";
import type { BoardAuthor, CardStatus } from "../workflow/card.ts";
import { ownerWorkflowEngineLayer } from "../workflow/owner-workflow-engine.ts";
import { OwnerWorkflowStorage, type StoredExecution } from "../workflow/owner-workflow-storage.ts";
import { Workflows, WorkflowStorageError } from "../workflow/workflow.ts";

/** What a card waits on a person for. The metadata is safe to show: no provider text or paths. */
export const DecisionKind = Schema.Union([
  /**
   * An attempt's run left a tool whose effect is unknown; the person says what really happened.
   * `toolNames` is empty when the run's records do not name the tools.
   */
  Schema.TaggedStruct("UncertainSideEffect", {
    runId: Schema.String,
    toolNames: Schema.Array(Schema.String),
  }),
  /** Integrating the card into the Goal branch conflicted in these files. */
  Schema.TaggedStruct("IntegrationConflict", { files: Schema.Array(Schema.String) }),
  /** A Goal change whose effect on the card the orchestrator could not judge (NeedsDecision). */
  Schema.TaggedStruct("ImpactUnclear", {
    fromGoalVersion: Schema.Int,
    toGoalVersion: Schema.Int,
  }),
  /** Every attempt of the card failed. */
  Schema.TaggedStruct("RetryExhausted", { attempts: Schema.Int }),
  /**
   * The Goal would merge into a protected branch, which is never automatic. A pull request is
   * offered only when the GitHub CLI was found when the Goal asked.
   */
  Schema.TaggedStruct("ProtectedBranchMerge", {
    targetBranch: Schema.String,
    prAvailable: Schema.Boolean,
  }),
  /** Merging the user's branch into the Goal branch conflicted in these files. */
  Schema.TaggedStruct("MergeConflict", {
    targetBranch: Schema.String,
    files: Schema.Array(Schema.String),
  }),
  /**
   * The card's expected files overlap a card another Goal finished but has not merged yet; the
   * scheduler cannot tell which Goal should go first.
   */
  Schema.TaggedStruct("FileOverlap", {
    otherGoalInstanceId: Schema.String,
    otherCardId: Schema.String,
    files: Schema.Array(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type DecisionKind = typeof DecisionKind.Type;

/**
 * The card id of Goal-level requests. They are about the Goal's merge into the user's branch, not
 * a card, so they move no card. A worktree card id cannot start with `@`.
 */
export const goalDecisionCardId = "@goal";

/** Whether a request kind is about one card or the whole Goal. */
export const decisionSubject: (kind: DecisionKind) => "card" | "goal" = DecisionKind.match({
  UncertainSideEffect: () => "card" as const,
  IntegrationConflict: () => "card" as const,
  ImpactUnclear: () => "card" as const,
  RetryExhausted: () => "card" as const,
  FileOverlap: () => "card" as const,
  ProtectedBranchMerge: () => "goal" as const,
  MergeConflict: () => "goal" as const,
});

/** A person's answer; its tag must be the request's kind. */
export const DecisionAnswer = Schema.Union([
  Schema.TaggedStruct("UncertainSideEffect", {
    choice: Schema.Literals(["continue", "retry", "stop"]),
  }),
  Schema.TaggedStruct("IntegrationConflict", {
    choice: Schema.Literals(["resolved", "rework", "stop"]),
  }),
  Schema.TaggedStruct("ImpactUnclear", {
    choice: Schema.Literals(["continue", "replace", "stop"]),
  }),
  Schema.TaggedStruct("RetryExhausted", { choice: Schema.Literals(["requeue", "stop"]) }),
  Schema.TaggedStruct("ProtectedBranchMerge", {
    choice: Schema.Literals(["create_pr", "manual_merge"]),
  }),
  Schema.TaggedStruct("MergeConflict", { choice: Schema.Literals(["resolved", "stop"]) }),
  Schema.TaggedStruct("FileOverlap", { choice: Schema.Literals(["wait", "proceed"]) }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type DecisionAnswer = typeof DecisionAnswer.Type;

/**
 * Each choice and the card status it leads to; Goal-level choices move no card. The orchestrator
 * reads the answer itself for what to do next (for example `continue` and `retry` both make the
 * card ready again).
 */
export const decisionChoices = {
  UncertainSideEffect: { continue: "ready", retry: "ready", stop: "blocked" },
  IntegrationConflict: { resolved: "verify", rework: "ready", stop: "blocked" },
  ImpactUnclear: { continue: "ready", replace: "blocked", stop: "blocked" },
  RetryExhausted: { requeue: "ready", stop: "blocked" },
  ProtectedBranchMerge: { create_pr: null, manual_merge: null },
  MergeConflict: { resolved: null, stop: null },
  FileOverlap: { wait: "ready", proceed: "ready" },
} as const satisfies {
  readonly [Tag in DecisionAnswer["_tag"]]: Record<
    Extract<DecisionAnswer, { readonly _tag: Tag }>["choice"],
    CardStatus | null
  >;
};

export const answeredCardStatus: (answer: DecisionAnswer) => CardStatus | null =
  DecisionAnswer.match({
    UncertainSideEffect: ({ choice }) => decisionChoices.UncertainSideEffect[choice],
    IntegrationConflict: ({ choice }) => decisionChoices.IntegrationConflict[choice],
    ImpactUnclear: ({ choice }) => decisionChoices.ImpactUnclear[choice],
    RetryExhausted: ({ choice }) => decisionChoices.RetryExhausted[choice],
    ProtectedBranchMerge: ({ choice }) => decisionChoices.ProtectedBranchMerge[choice],
    MergeConflict: ({ choice }) => decisionChoices.MergeConflict[choice],
    FileOverlap: ({ choice }) => decisionChoices.FileOverlap[choice],
  });

/** Why a wait ended without an answer. A close is never an answer, and never a refusal. */
export const DecisionCloseReason = Schema.Literals([
  "orchestrator_cancelled",
  "goal_replaced",
  "card_stopped",
]);
export type DecisionCloseReason = typeof DecisionCloseReason.Type;

export type DecisionState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Answered"; readonly answer: DecisionAnswer }
  | { readonly _tag: "Closed"; readonly reason: DecisionCloseReason | null };

export interface HumanDecisionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly cardId: string;
  readonly kind: DecisionKind;
  readonly createdAt: number;
  readonly state: DecisionState;
}

/** An unanswered request in a project's inbox, with names to show it by. */
export interface DecisionInboxItem extends HumanDecisionRequest {
  readonly sessionTitle: string | null;
  readonly cardTitle: string;
}

/** What the orchestrator asks. `key` is stable per occasion, so a retried request is the same one. */
export interface DecisionRequestInput {
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly cardId: string;
  readonly key: string;
  readonly kind: DecisionKind;
  /** Recorded on the card's move to `human_decision`. */
  readonly author: BoardAuthor;
}

/** A person's answer, admitted only when it names the request's own session, Goal and card. */
export interface DecisionAnswerInput {
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly cardId: string;
  readonly requestId: string;
  readonly answer: DecisionAnswer;
}

/** Which open waits a close ends. */
export type DecisionCloseScope =
  | { readonly _tag: "Request"; readonly requestId: string }
  | {
      readonly _tag: "Card";
      readonly sessionId: string;
      readonly goalInstanceId: string;
      readonly cardId: string;
    }
  | { readonly _tag: "Goal"; readonly sessionId: string; readonly goalInstanceId: string };

export class HumanDecisionRefused extends Schema.TaggedError<HumanDecisionRefused>()(
  "HumanDecisionRefused",
  {
    reason: Schema.Literals([
      "card_missing",
      "goal_superseded",
      "request_missing",
      "request_mismatch",
      "request_closed",
      "answer_invalid",
      "answer_conflict",
    ]),
  },
) {}

const HumanDecisionPayload = Schema.Struct({
  sessionId: Schema.String,
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  key: Schema.String,
  kind: DecisionKind,
  createdAt: Schema.Finite,
});
type HumanDecisionPayload = typeof HumanDecisionPayload.Type;

const HumanDecisionExecution = Workflow.make("HumanDecisionExecution", {
  payload: HumanDecisionPayload,
  success: Schema.Struct({ answer: DecisionAnswer, applied: Schema.Boolean }),
  error: WorkflowStorageError,
  idempotencyKey: ({ sessionId, goalInstanceId, cardId, key }) =>
    [sessionId, goalInstanceId, cardId, key].join("\u0000"),
});

const DecisionAnswered = DurableDeferred.make("HumanDecision/Answer", { success: DecisionAnswer });

/**
 * Moves the answered card as the user. A card that left `human_decision`, or a Goal that was
 * replaced meanwhile, keeps the answer but moves nothing; a Goal-level answer has no card.
 */
const applyAnswer = (payload: HumanDecisionPayload, answer: DecisionAnswer) =>
  Effect.gen(function* () {
    const workflows = yield* Workflows;
    const to = answeredCardStatus(answer);
    if (
      to === null ||
      (yield* workflows.goalInstanceId(payload.sessionId)) !== payload.goalInstanceId
    )
      return false;
    return yield* workflows
      .transitionCard(
        payload.sessionId,
        {
          cardId: payload.cardId,
          from: "human_decision",
          to,
          detail: `card ${payload.cardId} decided: ${answer.choice}`,
        },
        { _tag: "User" },
      )
      .pipe(
        Effect.as(true),
        Effect.catchTag("BoardEditRefused", () => Effect.succeed(false)),
      );
  });

const decisionHandler = (payload: HumanDecisionPayload) =>
  Effect.gen(function* () {
    const answer = yield* DurableDeferred.await(DecisionAnswered);
    const applied = yield* Activity.make({
      name: "HumanDecision/ApplyAnswer",
      success: Schema.Boolean,
      error: WorkflowStorageError,
      execute: applyAnswer(payload, answer),
    });
    return { answer, applied };
  });

const StoredAnswer = Schema.TaggedStruct("Success", { value: DecisionAnswer });
const ClosureRow = Schema.Struct({ reason: DecisionCloseReason });
const SessionRow = Schema.Struct({ id: Schema.String, title: Schema.NullOr(Schema.String) });

/** An answer must be for the request's kind; a pull request needs the GitHub CLI. */
const answerFits = (kind: DecisionKind, answer: DecisionAnswer) =>
  DecisionKind.matchOrElse(
    kind,
    {
      ProtectedBranchMerge: ({ prAvailable }) =>
        DecisionAnswer.guards.ProtectedBranchMerge(answer) &&
        (answer.choice !== "create_pr" || prAvailable),
    },
    (other) => Predicate.isTagged(answer, other._tag),
  );

const sameAnswer = (left: DecisionAnswer, right: DecisionAnswer) =>
  Predicate.isTagged(right, left._tag) && left.choice === right.choice;

const make = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const storage = yield* OwnerWorkflowStorage;
  const workflows = yield* Workflows;
  const sql = yield* SqlClient.SqlClient;
  // Requests ride on board changes, so pages refresh them with the board.
  const events = yield* AppEvents;
  const provideEngine = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
    Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine);
  const stored = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(effect, (cause) =>
      KanbanStorageFailed.make({ operation: "decision", reason: { _tag: "Storage" }, cause }),
    );
  /** A request or answer this owner just stored is not there to read back. */
  const missing = KanbanStorageFailed.make({ operation: "decision", reason: { _tag: "Missing" } });

  const closureRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ClosureRow,
    execute: (executionId) =>
      sql`SELECT reason FROM human_decision_closures WHERE execution_id = ${executionId}`,
  });
  const closure = (executionId: string) => stored(closureRow(executionId));
  const recordClosure = (executionId: string, reason: DecisionCloseReason, closedAt: string) =>
    stored(sql`INSERT OR IGNORE INTO human_decision_closures (execution_id, reason, closed_at)
      VALUES (${executionId}, ${reason}, ${closedAt})`);
  const projectSessions = SqlSchema.findAll({
    Request: Schema.String,
    Result: SessionRow,
    execute: (projectId) => sql`SELECT id, title FROM sessions WHERE project_id = ${projectId}`,
  });

  const decoded = (execution: StoredExecution) =>
    execution.workflowName === HumanDecisionExecution._tag
      ? Result.getSuccess(Schema.decodeUnknownResult(HumanDecisionPayload)(execution.payload))
      : Option.none();

  const storedAnswer = (executionId: string) =>
    Effect.map(stored(storage.deferredResult(executionId, DecisionAnswered.name)), (result) =>
      Option.flatMap(result, (value) =>
        Option.map(
          Result.getSuccess(Schema.decodeUnknownResult(StoredAnswer)(value)),
          (exit) => exit.value,
        ),
      ),
    );

  const stateOf = (execution: StoredExecution) =>
    Effect.gen(function* () {
      const answer = yield* storedAnswer(execution.executionId);
      if (Option.isSome(answer))
        return { _tag: "Answered", answer: answer.value } satisfies DecisionState;
      const closed = yield* closure(execution.executionId);
      if (Option.isSome(closed))
        return { _tag: "Closed", reason: closed.value.reason } satisfies DecisionState;
      const state: DecisionState =
        execution.status === "interrupted" ? { _tag: "Closed", reason: null } : { _tag: "Pending" };
      return state;
    });

  const view = (execution: StoredExecution, payload: HumanDecisionPayload) =>
    Effect.map(stateOf(execution), (state): HumanDecisionRequest => ({
      requestId: execution.executionId,
      sessionId: payload.sessionId,
      goalInstanceId: payload.goalInstanceId,
      cardId: payload.cardId,
      kind: payload.kind,
      createdAt: payload.createdAt,
      state,
    }));

  const read = (requestId: string) =>
    Effect.map(stored(storage.execution(requestId)), (found) =>
      Option.flatMap(found, (execution) =>
        Option.map(decoded(execution), (payload) => ({ execution, payload })),
      ),
    );

  /** Every request of this kind with its payload; other workflows' executions are skipped. */
  const requests = (executions: ReadonlyArray<StoredExecution>) =>
    Effect.forEach(
      executions.flatMap((execution) =>
        Option.match(decoded(execution), {
          onNone: () => [],
          onSome: (payload) => [{ execution, payload }],
        }),
      ),
      ({ execution, payload }) => view(execution, payload),
    );

  /** Waits that are still open: not answered and not closed. */
  const open = () =>
    stored(storage.pendingExecutions(HumanDecisionExecution._tag)).pipe(
      Effect.flatMap(requests),
      Effect.map((all) => all.filter((request) => Predicate.isTagged(request.state, "Pending"))),
    );

  /** A Goal instance's requests in any state, newest first. */
  const ofGoal = (sessionId: string, goalInstanceId: string) =>
    stored(storage.workflowExecutions(HumanDecisionExecution._tag)).pipe(
      Effect.map((executions) =>
        executions.filter((execution) =>
          Option.exists(
            decoded(execution),
            (payload) =>
              payload.sessionId === sessionId && payload.goalInstanceId === goalInstanceId,
          ),
        ),
      ),
      Effect.flatMap(requests),
      Effect.map((all) => all.toSorted((left, right) => right.createdAt - left.createdAt)),
    );

  const pointer = (sessionId: string) => workflows.goalInstanceId(sessionId);

  /** Records why, then interrupts. A restart finishes a close whose interrupt did not happen. */
  const closeOne = (
    request: Pick<HumanDecisionRequest, "requestId" | "sessionId">,
    reason: DecisionCloseReason,
  ) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* recordClosure(request.requestId, reason, now);
      yield* provideEngine(HumanDecisionExecution.interrupt(request.requestId));
      yield* events.publishSession(request.sessionId, "run-state");
    });

  const closeWhere = (
    matches: (request: HumanDecisionRequest) => boolean,
    reason: DecisionCloseReason,
  ) =>
    Effect.gen(function* () {
      const targets = (yield* open()).filter(matches);
      yield* Effect.forEach(targets, (request) => closeOne(request, reason), {
        discard: true,
      });
      return targets.length;
    });

  const closeSuperseded = (sessionId: string) =>
    Effect.gen(function* () {
      const current = yield* pointer(sessionId);
      return yield* closeWhere(
        (request) => request.sessionId === sessionId && request.goalInstanceId !== current,
        "goal_replaced",
      );
    });

  /** Open requests of the session's current Goal, oldest first. */
  const pendingOf = (sessionIds: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const requests = (yield* open()).filter((request) => sessionIds.has(request.sessionId));
      const current = new Map<string, string | null>();
      for (const sessionId of new Set(requests.map((request) => request.sessionId)))
        current.set(sessionId, yield* pointer(sessionId));
      return requests
        .filter((request) => current.get(request.sessionId) === request.goalInstanceId)
        .sort((left, right) => left.createdAt - right.createdAt);
    });

  // Finish closes that a crash interrupted, and close waits whose Goal was replaced meanwhile.
  yield* Effect.forEach(
    yield* stored(storage.pendingExecutions(HumanDecisionExecution._tag)),
    (execution) =>
      Effect.flatMap(closure(execution.executionId), (closed) =>
        Option.isNone(closed)
          ? Effect.void
          : provideEngine(HumanDecisionExecution.interrupt(execution.executionId)),
      ),
    { discard: true },
  );
  yield* Effect.forEach(
    new Set((yield* open()).map((request) => request.sessionId)),
    closeSuperseded,
    { discard: true },
  );

  return {
    /**
     * Moves the card to `human_decision` and starts a durable wait for the answer. A request with
     * the same session, Goal, card and key is the existing one, whatever its state.
     */
    request: (input: DecisionRequestInput) =>
      Effect.gen(function* () {
        const payload: HumanDecisionPayload = {
          sessionId: input.sessionId,
          goalInstanceId: input.goalInstanceId,
          cardId: input.cardId,
          key: input.key,
          kind: input.kind,
          createdAt: yield* Clock.currentTimeMillis,
        };
        const requestId = yield* HumanDecisionExecution.executionId(payload);
        const existing = yield* read(requestId);
        if (Option.isSome(existing))
          return yield* view(existing.value.execution, existing.value.payload);
        if ((yield* pointer(input.sessionId)) !== input.goalInstanceId)
          return yield* HumanDecisionRefused.make({ reason: "goal_superseded" });
        switch (decisionSubject(input.kind)) {
          case "goal":
            if (input.cardId !== goalDecisionCardId)
              return yield* HumanDecisionRefused.make({ reason: "request_mismatch" });
            break;
          case "card": {
            const card = (yield* workflows.get(input.sessionId)).plan?.steps.find(
              (step) => step.id === input.cardId,
            );
            if (card === undefined)
              return yield* HumanDecisionRefused.make({ reason: "card_missing" });
            // The card moves first: a wait never exists for a card the orchestrator still runs.
            if (card.status !== "human_decision")
              yield* workflows.transitionCard(
                input.sessionId,
                {
                  cardId: input.cardId,
                  from: card.status,
                  to: "human_decision",
                  detail: `card ${input.cardId} waits for a decision: ${input.kind._tag}`,
                },
                input.author,
              );
          }
        }
        yield* provideEngine(HumanDecisionExecution.execute(payload, { discard: true }));
        yield* events.publishSession(input.sessionId, "run-state");
        // A concurrent request with the same key may have admitted first; its payload wins.
        const admitted = yield* read(requestId);
        if (Option.isNone(admitted)) return yield* missing;
        return yield* view(admitted.value.execution, admitted.value.payload);
      }),

    /**
     * Completes the wait with a person's answer and moves the card. The same answer again is
     * accepted; a different one is refused. Closed requests and other Goals' requests are refused.
     */
    answer: (input: DecisionAnswerInput) =>
      Effect.gen(function* () {
        const found = yield* read(input.requestId);
        if (Option.isNone(found))
          return yield* HumanDecisionRefused.make({ reason: "request_missing" });
        const { execution, payload } = found.value;
        if (
          payload.sessionId !== input.sessionId ||
          payload.goalInstanceId !== input.goalInstanceId ||
          payload.cardId !== input.cardId
        )
          return yield* HumanDecisionRefused.make({ reason: "request_mismatch" });
        if (!answerFits(payload.kind, input.answer))
          return yield* HumanDecisionRefused.make({ reason: "answer_invalid" });
        const settle = Effect.gen(function* () {
          const answer = yield* storedAnswer(execution.executionId);
          if (Option.isNone(answer)) return yield* missing;
          if (!sameAnswer(answer.value, input.answer))
            return yield* HumanDecisionRefused.make({ reason: "answer_conflict" });
          // Joins the run, so the card has moved when the answer returns. A failed move stays a
          // failure: the answer is stored, but the card did not leave human_decision.
          yield* provideEngine(HumanDecisionExecution.execute(payload));
          const current = yield* read(input.requestId);
          if (Option.isNone(current)) return yield* missing;
          return yield* view(current.value.execution, current.value.payload);
        });
        const admit = Effect.gen(function* () {
          if ((yield* pointer(input.sessionId)) !== payload.goalInstanceId) {
            yield* closeOne(input, "goal_replaced");
            return yield* HumanDecisionRefused.make({ reason: "goal_superseded" });
          }
          const token = DurableDeferred.tokenFromExecutionId(DecisionAnswered, {
            workflow: HumanDecisionExecution,
            executionId: execution.executionId,
          });
          yield* provideEngine(
            DurableDeferred.succeed(DecisionAnswered, { token, value: input.answer }),
          );
          // Two different answers may race; the stored one decides, and the other is a conflict.
          const settled = yield* settle;
          yield* events.publishSession(input.sessionId, "run-state");
          return settled;
        });
        const state = yield* stateOf(execution);
        return yield* Match.valueTags(state, {
          Answered: () => settle,
          Closed: () => Effect.fail(HumanDecisionRefused.make({ reason: "request_closed" })),
          Pending: () => admit,
        });
      }),

    /** Ends open waits without an answer. Returns how many it closed. */
    close: (scope: DecisionCloseScope, reason: DecisionCloseReason) =>
      Match.valueTags(scope, {
        Request: ({ requestId }) =>
          closeWhere((request) => request.requestId === requestId, reason),
        Card: (card) =>
          closeWhere(
            (request) =>
              request.sessionId === card.sessionId &&
              request.goalInstanceId === card.goalInstanceId &&
              request.cardId === card.cardId,
            reason,
          ),
        Goal: (goal) =>
          closeWhere(
            (request) =>
              request.sessionId === goal.sessionId &&
              request.goalInstanceId === goal.goalInstanceId,
            reason,
          ),
      }),

    /** Closes the session's open waits whose Goal is no longer the session's current one. */
    closeSuperseded,

    /** A request in any state, for the orchestrator to read the answer after the card moved. */
    get: (requestId: string) =>
      Effect.flatMap(read(requestId), (found) =>
        Option.match(found, {
          onNone: () => Effect.succeedNone,
          onSome: ({ execution, payload }) => Effect.asSome(view(execution, payload)),
        }),
      ),

    /** A card's requests in any state, newest first. */
    forCard: (sessionId: string, goalInstanceId: string, cardId: string) =>
      Effect.map(ofGoal(sessionId, goalInstanceId), (all) =>
        all.filter((request) => request.cardId === cardId),
      ),

    /** A Goal instance's requests in any state, newest first, for the loop to take up answers. */
    forGoal: (sessionId: string, goalInstanceId: string) => ofGoal(sessionId, goalInstanceId),

    /** Unanswered requests of the session's current Goal, oldest first. */
    pending: (sessionId: string) => pendingOf(new Set([sessionId])),

    /** Unanswered requests across the project's sessions and their current Goals, oldest first. */
    inbox: (projectId: string) =>
      Effect.gen(function* () {
        const sessions = yield* stored(projectSessions(projectId));
        const titles = new Map(sessions.map((session) => [session.id, session.title]));
        const requests = yield* pendingOf(new Set(titles.keys()));
        const cardTitles = new Map<string, Map<string, string>>();
        for (const sessionId of new Set(requests.map((request) => request.sessionId))) {
          const steps = (yield* workflows.get(sessionId)).plan?.steps ?? [];
          cardTitles.set(sessionId, new Map(steps.map((step) => [step.id, step.title])));
        }
        return requests.map((request): DecisionInboxItem => ({
          ...request,
          sessionTitle: titles.get(request.sessionId) ?? null,
          cardTitle:
            cardTitles.get(request.sessionId)?.get(request.cardId) ??
            (request.cardId === goalDecisionCardId ? "Goal" : request.cardId),
        }));
      }),
  };
});

/**
 * Durable `human_decision` waits of kanban cards. Each wait is an Effect Workflow whose answer is a
 * schema-typed DurableDeferred, so a restart resumes it; a close interrupts it.
 */
export class HumanDecisions extends Context.Service<HumanDecisions, Effect.Success<typeof make>>()(
  "memory-agent/kanban/human-decision/HumanDecisions",
) {
  static readonly layer = Layer.merge(
    Layer.effect(HumanDecisions, make),
    HumanDecisionExecution.toLayer(decisionHandler),
  ).pipe(
    Layer.provide([Workflows.layer, AppEvents.layer]),
    Layer.provideMerge(ownerWorkflowEngineLayer),
  );
}
