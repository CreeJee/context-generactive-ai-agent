import {
  Array as EffectArray,
  Clock,
  Context,
  Data,
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
import { KanbanStorageFailed, KanbanStorageReason } from "./card-attempts.ts";
import { BoardAuthor, type CardStatus } from "../workflow/card.ts";
import {
  ownerWorkflowEngineLayer,
  suspendedRetrySchedule,
} from "../workflow/owner-workflow-engine.ts";
import {
  OwnerWorkflowAdmission,
  OwnerWorkflowAdmissionResult,
  OwnerWorkflowStorage,
  type StoredExecution,
} from "../workflow/owner-workflow-storage.ts";
import { Workflows, WorkflowStorageError } from "../workflow/workflow.ts";
import {
  DecisionKind,
  HumanDecisionPayload,
  humanDecisionWorkflow,
} from "./human-decision-schema.ts";

export { DecisionKind } from "./human-decision-schema.ts";

/** The kind's tag, as the card's history and pages name it. */
export const decisionKindName = DecisionKind.match({
  UncertainSideEffect: () => "UncertainSideEffect" as const,
  IntegrationConflict: () => "IntegrationConflict" as const,
  ImpactUnclear: () => "ImpactUnclear" as const,
  RetryExhausted: () => "RetryExhausted" as const,
  ProtectedBranchMerge: () => "ProtectedBranchMerge" as const,
  MergeConflict: () => "MergeConflict" as const,
  FileOverlap: () => "FileOverlap" as const,
});

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
export const DecisionAnswer = Schema.TaggedUnion({
  UncertainSideEffect: { choice: Schema.Literals(["continue", "retry", "stop"]) },
  IntegrationConflict: { choice: Schema.Literals(["resolved", "rework", "stop"]) },
  ImpactUnclear: { choice: Schema.Literals(["continue", "replace", "stop"]) },
  RetryExhausted: { choice: Schema.Literals(["requeue", "stop"]) },
  ProtectedBranchMerge: { choice: Schema.Literals(["create_pr", "manual_merge"]) },
  MergeConflict: { choice: Schema.Literals(["resolved", "stop"]) },
  FileOverlap: { choice: Schema.Literals(["wait", "proceed"]) },
});
export type DecisionAnswer = typeof DecisionAnswer.Type;

/** The answer's tag; it names the request kind the answer is for. */
const decisionAnswerName = DecisionAnswer.match({
  UncertainSideEffect: () => "UncertainSideEffect" as const,
  IntegrationConflict: () => "IntegrationConflict" as const,
  ImpactUnclear: () => "ImpactUnclear" as const,
  RetryExhausted: () => "RetryExhausted" as const,
  ProtectedBranchMerge: () => "ProtectedBranchMerge" as const,
  MergeConflict: () => "MergeConflict" as const,
  FileOverlap: () => "FileOverlap" as const,
});

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
  readonly [Tag in keyof typeof DecisionAnswer.cases]: Record<
    (typeof DecisionAnswer.cases)[Tag]["fields"]["choice"]["Type"],
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

export type DecisionState = Data.TaggedEnum<{
  Pending: {};
  Answered: { readonly answer: DecisionAnswer };
  Closed: { readonly reason: DecisionCloseReason | null };
}>;
export const DecisionState = Data.taggedEnum<DecisionState>();

export interface HumanDecisionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly cardId: string;
  /** The latest facts the orchestrator saw at the occasion. */
  readonly kind: DecisionKind;
  /** Which facts `kind` is, counting from 1; an answer names it. */
  readonly factsSeq: number;
  /** The facts changed after the request first asked. */
  readonly factsChanged: boolean;
  readonly createdAt: number;
  readonly state: DecisionState;
}

/** An unanswered request in a project's inbox, with names to show it by. */
export interface DecisionInboxItem extends HumanDecisionRequest {
  readonly sessionTitle: string | null;
  readonly cardTitle: string;
}

/**
 * What a request asks about, one case per kind. The same occasion of a card is the same request,
 * however its facts changed meanwhile.
 */
export type DecisionOccasion = Data.TaggedEnum<{
  UncertainSideEffect: { readonly runId: string; readonly attemptNo: number };
  IntegrationConflict: { readonly attemptNo: number; readonly answered: number };
  ImpactUnclear: { readonly fromVersion: number; readonly toVersion: number };
  RetryExhausted: { readonly attemptNo: number };
  ProtectedBranchMerge: { readonly head: string };
  MergeConflict: { readonly goalHead: string; readonly targetHead: string };
  FileOverlap: { readonly otherGoalInstanceId: string };
}>;
export const DecisionOccasion = Data.taggedEnum<DecisionOccasion>();

/** The occasion's part of the request's identity, in the form stored requests already use. */
const occasionKey = (occasion: DecisionOccasion) =>
  Match.valueTags(occasion, {
    UncertainSideEffect: ({ runId, attemptNo }) => `uncertain_side_effect:${runId}:${attemptNo}`,
    IntegrationConflict: ({ attemptNo, answered }) =>
      `integration_conflict:${attemptNo}:${answered}`,
    ImpactUnclear: ({ fromVersion, toVersion }) => `impact_unclear:${fromVersion}:${toVersion}`,
    RetryExhausted: ({ attemptNo }) => `retry_exhausted:${attemptNo}`,
    ProtectedBranchMerge: ({ head }) => `protected_branch:${head}`,
    MergeConflict: ({ goalHead, targetHead }) => `merge_conflict:${goalHead}:${targetHead}`,
    FileOverlap: ({ otherGoalInstanceId }) => `file_overlap:${otherGoalInstanceId}`,
  });

/** An occasion and the facts seen at it, both of one kind. */
export type DecisionAsked = {
  readonly [Tag in DecisionKind["_tag"]]: {
    readonly occasion: Extract<DecisionOccasion, { readonly _tag: Tag }>;
    readonly kind: Extract<DecisionKind, { readonly _tag: Tag }>;
  };
}[DecisionKind["_tag"]];

/** What the orchestrator asks. Asking the same occasion again adds changed facts to its request. */
export type DecisionRequestInput = DecisionAsked & {
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly cardId: string;
  /** Recorded on the card's move to `human_decision`. */
  readonly author: BoardAuthor;
};

/** A person's answer, admitted only when it names the request's own session, Goal and card. */
export interface DecisionAnswerInput {
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly cardId: string;
  readonly requestId: string;
  /** The facts the person answered; older ones than the latest are refused. */
  readonly factsSeq: number;
  readonly answer: DecisionAnswer;
}

/** Which open waits a close ends. */
export type DecisionCloseScope = Data.TaggedEnum<{
  Request: { readonly requestId: string };
  Card: {
    readonly sessionId: string;
    readonly goalInstanceId: string;
    readonly cardId: string;
  };
  Goal: { readonly sessionId: string; readonly goalInstanceId: string };
}>;
export const DecisionCloseScope = Data.taggedEnum<DecisionCloseScope>();

export class HumanDecisionRefused extends Schema.TaggedError<
  HumanDecisionRefused,
  { readonly brand: unique symbol }
>()("HumanDecisionRefused", {
  reason: Schema.Literals([
    "card_missing",
    "goal_superseded",
    "request_missing",
    "request_mismatch",
    "request_closed",
    "answer_invalid",
    "answer_conflict",
    "facts_changed",
  ]),
}) {}

const HumanDecisionExecution = Workflow.make(humanDecisionWorkflow, {
  payload: HumanDecisionPayload,
  success: Schema.Struct({ answer: DecisionAnswer, applied: Schema.Boolean }),
  error: WorkflowStorageError,
  idempotencyKey: ({ sessionId, goalInstanceId, cardId, key }) =>
    [sessionId, goalInstanceId, cardId, key].join("\u0000"),
  suspendedRetrySchedule,
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
        BoardAuthor.cases.User.make({}),
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
const FactsRow = Schema.Struct({
  seq: Schema.Int,
  kind_json: Schema.String,
  observed_at: Schema.Finite,
});
const decodeKind = Schema.decodeUnknownResult(Schema.fromJsonString(DecisionKind));
const encodeKind = Schema.encodeEffect(Schema.fromJsonString(DecisionKind));

/** What the orchestrator saw at an occasion, as the request's latest `human_decision_facts` row. */
interface Facts {
  readonly seq: number;
  readonly kind: DecisionKind;
  /** The stored JSON, which tells whether facts seen again changed. */
  readonly json: string;
  readonly observedAt: number;
}

/** A stored request: its execution, its identity and its latest facts. */
interface StoredRequest {
  readonly execution: StoredExecution;
  readonly payload: HumanDecisionPayload;
  readonly facts: Facts;
}
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
    (other) => DecisionAnswer.guards[decisionKindName(other)](answer),
  );

const sameAnswer = (left: DecisionAnswer, right: DecisionAnswer) =>
  DecisionAnswer.guards[decisionAnswerName(left)](right) && left.choice === right.choice;

const make = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const storage = yield* OwnerWorkflowStorage;
  const admission = yield* OwnerWorkflowAdmission;
  const workflows = yield* Workflows;
  const sql = yield* SqlClient.SqlClient;
  // Requests ride on board changes, so pages refresh them with the board.
  const events = yield* AppEvents;
  const provideEngine = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
    Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine);
  const storageFailed = (cause: unknown) =>
    KanbanStorageFailed.make({
      operation: "decision",
      reason: KanbanStorageReason.cases.Storage.make({}),
      cause,
    });
  const stored = <A, E>(effect: Effect.Effect<A, E>) => Effect.mapError(effect, storageFailed);
  /** A request or answer this owner just stored is not there to read back. */
  const missing = KanbanStorageFailed.make({
    operation: "decision",
    reason: KanbanStorageReason.cases.Missing.make({}),
  });

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
    execution.workflowName === humanDecisionWorkflow
      ? Result.getSuccess(Schema.decodeUnknownResult(HumanDecisionPayload)(execution.payload))
      : Option.none();
  const latestFacts = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: FactsRow,
    execute: (executionId) => sql`SELECT seq, kind_json, observed_at FROM human_decision_facts
      WHERE execution_id = ${executionId} ORDER BY seq DESC LIMIT 1`,
  });
  /** A request's latest facts; none when there are none it can read. */
  const factsOf = (executionId: string) =>
    Effect.map(
      stored(latestFacts(executionId)),
      Option.flatMap((row) =>
        Option.map(Result.getSuccess(decodeKind(row.kind_json)), (kind): Facts => ({
          seq: row.seq,
          kind,
          json: row.kind_json,
          observedAt: row.observed_at,
        })),
      ),
    );
  const insertFacts = (executionId: string, seq: number, json: string) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (now) => sql`INSERT INTO human_decision_facts (execution_id, seq, kind_json, observed_at)
        VALUES (${executionId}, ${seq}, ${json}, ${now})`,
    );

  const storedAnswer = (executionId: string) =>
    Effect.map(stored(storage.deferredResult(executionId, DecisionAnswered.name)), (result) =>
      Option.flatMap(result, (value) =>
        Option.map(
          Result.getSuccess(Schema.decodeUnknownResult(StoredAnswer)(value)),
          (exit) => exit.value,
        ),
      ),
    );

  const stateOf = (execution: StoredExecution): Effect.Effect<DecisionState, KanbanStorageFailed> =>
    Effect.flatMap(
      storedAnswer(execution.executionId),
      Option.match({
        onSome: (answer) => Effect.succeed(DecisionState.Answered({ answer })),
        onNone: () =>
          Effect.map(
            closure(execution.executionId),
            Option.match({
              onSome: (closed): DecisionState => DecisionState.Closed({ reason: closed.reason }),
              onNone: (): DecisionState =>
                execution.status === "interrupted"
                  ? DecisionState.Closed({ reason: null })
                  : DecisionState.Pending(),
            }),
          ),
      }),
    );

  const view = ({ execution, payload, facts }: StoredRequest) =>
    Effect.map(stateOf(execution), (state): HumanDecisionRequest => ({
      requestId: execution.executionId,
      sessionId: payload.sessionId,
      goalInstanceId: payload.goalInstanceId,
      cardId: payload.cardId,
      kind: facts.kind,
      factsSeq: facts.seq,
      factsChanged: facts.seq > 1,
      createdAt: execution.createdAt ?? facts.observedAt,
      state,
    }));

  /** The request an execution holds; none for other workflows and for rows it cannot read. */
  const requestOf = (execution: StoredExecution) =>
    Option.match(decoded(execution), {
      onNone: () => Effect.succeedNone,
      onSome: (payload) =>
        Effect.map(
          factsOf(execution.executionId),
          Option.map((facts): StoredRequest => ({ execution, payload, facts })),
        ),
    });
  const read = (requestId: string) =>
    Effect.flatMap(
      stored(storage.execution(requestId)),
      Option.match({ onNone: () => Effect.succeedNone, onSome: requestOf }),
    );
  /** A request this owner just stored or answered, which must be there to read back. */
  const readStored = (requestId: string) =>
    Effect.flatMap(read(requestId), (found) => Effect.fromOption(found, () => missing));

  /** Every request of this kind; other workflows' executions and unreadable rows are skipped. */
  const requests = (executions: ReadonlyArray<StoredExecution>) =>
    Effect.forEach(executions, requestOf).pipe(
      Effect.flatMap((found) => Effect.forEach(EffectArray.getSomes(found), view)),
    );

  /**
   * Adds the facts seen at an occasion again to its open request when they changed, in one
   * transaction. An answered or closed request keeps its facts: the answer was for that occasion.
   * Returns whether it added them.
   */
  const appendFacts = (requestId: string, kind: DecisionKind) =>
    Effect.flatMap(stored(encodeKind(kind)), (json) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* read(requestId);
            if (Option.isNone(found) || found.value.facts.json === json) return false;
            if (!DecisionState.$is("Pending")(yield* stateOf(found.value.execution))) return false;
            yield* insertFacts(requestId, found.value.facts.seq + 1, json);
            return true;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(storageFailed(cause)))),
    );

  /** Waits that are still open: not answered and not closed. */
  const open = () =>
    stored(storage.pendingExecutions(humanDecisionWorkflow)).pipe(
      Effect.flatMap(requests),
      Effect.map((all) => all.filter((request) => Predicate.isTagged(request.state, "Pending"))),
    );

  /** A Goal instance's requests in any state, newest first. */
  const ofGoal = (sessionId: string, goalInstanceId: string) =>
    stored(storage.workflowExecutions(humanDecisionWorkflow)).pipe(
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
      const current = new Map(
        yield* Effect.forEach(new Set(requests.map((request) => request.sessionId)), (sessionId) =>
          Effect.map(pointer(sessionId), (goalInstanceId) => [sessionId, goalInstanceId] as const),
        ),
      );
      return requests
        .filter((request) => current.get(request.sessionId) === request.goalInstanceId)
        .sort((left, right) => left.createdAt - right.createdAt);
    });

  // Finish closes that a crash interrupted, and close waits whose Goal was replaced meanwhile.
  yield* Effect.forEach(
    yield* stored(storage.pendingExecutions(humanDecisionWorkflow)),
    (execution) =>
      Effect.when(
        provideEngine(HumanDecisionExecution.interrupt(execution.executionId)),
        Effect.map(closure(execution.executionId), Option.isSome),
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
     * the same session, Goal, card and occasion is the existing one, whatever its state; facts
     * that changed since are added to it while it waits.
     */
    request: (input: DecisionRequestInput) =>
      Effect.gen(function* () {
        const payload: HumanDecisionPayload = {
          sessionId: input.sessionId,
          goalInstanceId: input.goalInstanceId,
          cardId: input.cardId,
          key: occasionKey(input.occasion),
        };
        const requestId = yield* HumanDecisionExecution.executionId(payload);
        const changed = (added: boolean) =>
          Effect.when(events.publishSession(input.sessionId, "run-state"), Effect.succeed(added));
        if (Option.isSome(yield* read(requestId))) {
          yield* changed(yield* appendFacts(requestId, input.kind));
          return yield* view(yield* readStored(requestId));
        }
        yield* Effect.when(
          Effect.fail(HumanDecisionRefused.make({ reason: "goal_superseded" })),
          Effect.map(pointer(input.sessionId), (current) => current !== input.goalInstanceId),
        );
        yield* Match.value(decisionSubject(input.kind)).pipe(
          Match.when("goal", () =>
            Effect.when(
              Effect.fail(HumanDecisionRefused.make({ reason: "request_mismatch" })),
              Effect.succeed(input.cardId !== goalDecisionCardId),
            ),
          ),
          Match.when("card", () =>
            workflows.get(input.sessionId).pipe(
              Effect.flatMap((state) =>
                Effect.fromOption(
                  Option.fromUndefinedOr(
                    state.plan?.steps.find((step) => step.id === input.cardId),
                  ),
                  () => HumanDecisionRefused.make({ reason: "card_missing" }),
                ),
              ),
              // The card moves first: a wait never exists for a card the orchestrator still runs.
              Effect.flatMap((card) =>
                Effect.when(
                  workflows.transitionCard(
                    input.sessionId,
                    {
                      cardId: input.cardId,
                      from: card.status,
                      to: "human_decision",
                      detail: `card ${input.cardId} waits for a decision: ${decisionKindName(input.kind)}`,
                    },
                    input.author,
                  ),
                  Effect.succeed(card.status !== "human_decision"),
                ),
              ),
            ),
          ),
          Match.exhaustive,
        );
        const json = yield* stored(encodeKind(input.kind));
        const admitted = yield* stored(
          admission.admit(
            { workflowName: humanDecisionWorkflow, executionId: requestId, payload },
            insertFacts(requestId, 1, json),
          ),
        );
        // A concurrent request for the same occasion admitted first; these facts join it.
        yield* Effect.when(
          appendFacts(requestId, input.kind),
          Effect.succeed(OwnerWorkflowAdmissionResult.$is("existing")(admitted)),
        );
        yield* provideEngine(HumanDecisionExecution.execute(payload, { discard: true }));
        yield* events.publishSession(input.sessionId, "run-state");
        return yield* view(yield* readStored(requestId));
      }),

    /**
     * Completes the wait with a person's answer and moves the card. The same answer again is
     * accepted; a different one is refused. Closed requests, other Goals' requests and answers to
     * facts that changed since are refused.
     */
    answer: (input: DecisionAnswerInput) =>
      Effect.gen(function* () {
        const { execution, payload, facts } = yield* Effect.flatMap(
          read(input.requestId),
          (found) =>
            Effect.fromOption(found, () =>
              HumanDecisionRefused.make({ reason: "request_missing" }),
            ),
        );
        if (
          payload.sessionId !== input.sessionId ||
          payload.goalInstanceId !== input.goalInstanceId ||
          payload.cardId !== input.cardId
        )
          return yield* HumanDecisionRefused.make({ reason: "request_mismatch" });
        yield* Effect.when(
          Effect.fail(HumanDecisionRefused.make({ reason: "answer_invalid" })),
          Effect.succeed(!answerFits(facts.kind, input.answer)),
        );
        const settle = Effect.gen(function* () {
          const answer = yield* Effect.flatMap(storedAnswer(execution.executionId), (found) =>
            Effect.fromOption(found, () => missing),
          );
          yield* Effect.when(
            Effect.fail(HumanDecisionRefused.make({ reason: "answer_conflict" })),
            Effect.succeed(!sameAnswer(answer, input.answer)),
          );
          // Joins the run, so the card has moved when the answer returns. A failed move stays a
          // failure: the answer is stored, but the card did not leave human_decision.
          yield* provideEngine(HumanDecisionExecution.execute(payload));
          return yield* view(yield* readStored(input.requestId));
        });
        const admit = Effect.gen(function* () {
          // Compared without a lock: facts added between this and the answer are one step newer.
          yield* Effect.when(
            Effect.fail(HumanDecisionRefused.make({ reason: "facts_changed" })),
            Effect.succeed(input.factsSeq !== facts.seq),
          );
          yield* Effect.when(
            Effect.andThen(
              closeOne(input, "goal_replaced"),
              Effect.fail(HumanDecisionRefused.make({ reason: "goal_superseded" })),
            ),
            Effect.map(pointer(input.sessionId), (current) => current !== payload.goalInstanceId),
          );
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
          onSome: (found) => Effect.asSome(view(found)),
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
        const cardTitles = new Map(
          yield* Effect.forEach(
            new Set(requests.map((request) => request.sessionId)),
            (sessionId) =>
              Effect.map(
                workflows.get(sessionId),
                (state) =>
                  [
                    sessionId,
                    new Map((state.plan?.steps ?? []).map((step) => [step.id, step.title])),
                  ] as const,
              ),
          ),
        );
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
