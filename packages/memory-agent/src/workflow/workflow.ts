import { NodeCrypto } from "@effect/platform-node";
import {
  Array as Arr,
  Chunk,
  DateTime,
  Context,
  Data,
  Effect,
  HashMap,
  HashSet,
  Iterable,
  Layer,
  Match,
  MutableHashMap,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { optionalProperty } from "../optional-property.ts";
import { WorkflowActionReason } from "./actions.ts";
import {
  decodeGoalState,
  GoalEvent,
  goalStateOf,
  goalTransitions,
  reconciledPhase,
  type Standing,
  standingOf,
  stepsOf,
} from "./goal-transitions.ts";
import { currentStatesSql, revisionStateSql } from "./state-rows.ts";
import {
  BoardAuthor,
  CardStatus,
  cardContract,
  StepProgressStatus,
  type CardApproval,
} from "./card.ts";
import {
  type EditPlan,
  GoalArtifact,
  GoalOutcomes,
  GoalQuestion,
  LedgerEvent,
  PlanArtifact,
  type PlanEdit,
  PlanStep,
  planStepFields,
  StepWork,
  verificationDefault,
  WorkflowAction,
  type WorkflowDisplay,
  type WorkflowMove,
  type WorkflowPhase,
  WorkflowState,
  decodedPlace,
  storedPlaceFields,
} from "./contracts.ts";
import { notStartedStatus, validatePlanDependencies } from "./plan-schedule.ts";
import { validateStepOutcomes } from "./step-outcomes.ts";
import {
  BoardEditPlan,
  BoardEditRefused,
  BoardEditResult,
  closedPlan,
  planBoardEdit,
  planCardApproval,
  planCardHold,
  planCardTransition,
  UserChange,
  type BoardEdit,
  type CardApprovalChange,
  type CardTransition,
  type UserChangeRequest,
} from "./board-edit.ts";
import { acknowledgedRunSql, resolvedRunSql } from "./run-bindings.ts";
import { logFailure } from "../runtime/logged-failures.ts";

export {
  GoalArtifact,
  GoalOutcome,
  OutcomeId,
  PlanArtifact,
  PlanStep,
  VerificationStatus,
  WorkflowAction,
  WorkflowDisplay,
  WorkflowMode,
  WorkflowMove,
  WorkflowPhase,
  WorkflowState,
} from "./contracts.ts";
export type { Verification } from "./contracts.ts";

// Plans saved before cards hold pending/completed; they are read, never rewritten in place.
const PersistedPlanStep = Schema.Struct({
  ...PlanStep.fields,
  status: Schema.Union([CardStatus, StepProgressStatus]),
});

/** Reads saved step statuses as cards: pending is ready, or backlog until its dependencies are done. */
const cardStatuses = <S extends typeof PersistedPlanStep.Type>(
  steps: readonly S[],
): Array<Omit<S, "status"> & { readonly status: CardStatus }> => {
  const done = HashSet.fromIterable(
    Iterable.map(
      Iterable.filter(steps, (step) => step.status === "done" || step.status === "completed"),
      (step) => step.id,
    ),
  );
  const notStarted = notStartedStatus(steps, (id) => HashSet.has(done, id));
  return steps.map((step) => ({
    ...step,
    status: Match.value(step.status).pipe(
      Match.withReturnType<CardStatus>(),
      Match.when("pending", () => notStarted(step)),
      Match.when("completed", () => "done"),
      Match.orElse((status) => status),
    ),
  }));
};

/** Whether a replan left a step's work the same; which outcomes it serves is not its work. */
const sameStep = Schema.toEquivalence(StepWork);
/**
 * A step's progress through a replan. A started step whose work the replan leaves unchanged keeps
 * it; any other step starts over, and a step not started is placed again by its dependencies.
 */
const replannedProgress = (
  prior: PlanStep,
  step: UpdatePlan["steps"][number],
): Pick<typeof PersistedPlanStep.Type, "status" | "evidence"> =>
  sameStep(prior, step) && prior.status !== "backlog" && prior.status !== "ready"
    ? { status: prior.status, evidence: prior.evidence }
    : { status: "pending", evidence: [] };

/** The board change a model's Plan edit is, against Plan version `planVersion`. */
const boardEditOf = (
  edit: PlanEdit,
  planVersion: number,
): { readonly edit: BoardEdit; readonly newCardId: string } =>
  Match.value(edit).pipe(
    Match.discriminatorsExhaustive("action")({
      add: ({ step: { id, ...card }, index }) => ({
        edit: { _tag: "AddCard" as const, planVersion, card, ...optionalProperty("index", index) },
        newCardId: id,
      }),
      edit: ({ stepId, patch }) => ({
        edit: { _tag: "EditCard" as const, planVersion, cardId: stepId, patch },
        newCardId: "",
      }),
      move: ({ stepId, index }) => ({
        edit: { _tag: "MoveCard" as const, planVersion, cardId: stepId, index },
        newCardId: "",
      }),
      remove: ({ stepId }) => ({
        edit: { _tag: "CancelCard" as const, planVersion, cardId: stepId },
        newCardId: "",
      }),
    }),
  );

export const UpdateGoal = Schema.Struct({
  statement: Schema.String,
  outcomes: GoalOutcomes,
  constraints: Schema.Array(Schema.String),
  nonGoals: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  openQuestions: Schema.Array(GoalQuestion),
  status: Schema.Literals(["draft", "active"]),
});
export type UpdateGoal = typeof UpdateGoal.Type;

/** A separate independent success criterion, never an implicit updateGoal interpretation. */
export const StartNewGoal = Schema.Struct({
  action: Schema.Literal("new_independent_goal"),
  previousGoalInstanceId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  goal: UpdateGoal,
});
export type StartNewGoal = typeof StartNewGoal.Type;

export class NewGoalTransitionRefused extends Schema.TaggedError<
  NewGoalTransitionRefused,
  { readonly brand: unique symbol }
>()("NewGoalTransitionRefused", {
  reason: Schema.Literals([
    "disabled",
    "phase_not_authorized",
    "goal_missing",
    "workflow_changed",
    "run_outcome_uncertain",
    "transition_pending",
    "owner_effect_uncertain",
    "execution_outstanding",
  ]),
}) {}

/** Where a run's queued new Goal stands once the owner settles it; `none` when it queued none. */
export type NewGoalSettlement = Data.TaggedEnum<{
  none: {};
  accepted: {};
  applied: { readonly goalInstanceId: string | null };
  rejected: { readonly reason: NewGoalTransitionRefused["reason"] | null };
}>;
export const NewGoalSettlement = Data.taggedEnum<NewGoalSettlement>();

export const UpdatePlan = Schema.Struct({
  summary: Schema.String,
  steps: Schema.Array(Schema.Struct(planStepFields)),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  status: Schema.Literals(["draft", "ready"]),
});
export type UpdatePlan = typeof UpdatePlan.Type;

const emptyState = (): WorkflowState => ({
  phase: "chat",
  mode: "plan",
  goal: null,
  plan: null,
  ledger: [],
});

// A saved Plan's steps may still hold the statuses written before cards.
const PersistedPlanArtifact = Schema.Struct({
  ...PlanArtifact.fields,
  steps: Schema.Array(PersistedPlanStep),
});
const PersistedWorkflowState = Schema.Struct({
  ...storedPlaceFields,
  goal: Schema.NullOr(GoalArtifact),
  plan: Schema.NullOr(PersistedPlanArtifact),
  ledger: Schema.Array(LedgerEvent),
});
const persistedPlan = (plan: typeof PersistedPlanArtifact.Type | null): WorkflowState["plan"] =>
  plan === null ? null : { ...plan, steps: cardStatuses(plan.steps) };
export const decodeWorkflowState = (json: string) =>
  Schema.decodeEffect(Schema.fromJsonString(PersistedWorkflowState))(json).pipe(
    Effect.map((stored): WorkflowState => ({
      ...decodedPlace(stored),
      goal: stored.goal,
      plan: persistedPlan(stored.plan),
      ledger: stored.ledger,
    })),
  );
const decodePersistedPlan = Schema.decodeEffect(Schema.fromJsonString(PersistedPlanArtifact));
/** The Plan a revision keeps in `plan_json`; NULL when the revision has none. */
export const decodeRevisionPlan = (json: string | null) =>
  json === null ? Effect.succeed(null) : Effect.map(decodePersistedPlan(json), persistedPlan);
const encodeCard = Schema.encodeEffect(Schema.fromJsonString(PlanStep));
/** Each card of a revision's stored Plan in its encoded form, by id, in Plan order. */
export const revisionCards = (json: string | null) =>
  Effect.flatMap(decodeRevisionPlan(json), (plan) =>
    Effect.map(
      Effect.forEach(plan?.steps ?? [], (step) =>
        Effect.map(encodeCard(step), (encoded) => [step.id, encoded] as const),
      ),
      // The mutable map keeps Plan order, which `boardChange` reports the cards in.
      (entries): MutableHashMap.MutableHashMap<string, string> =>
        MutableHashMap.fromIterable(entries),
    ),
  );
const encodeCardIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
/** A card's notes for its next agent run, as `kanban_cards.notes_json` stores them. */
const encodeNotes = encodeCardIds;
/**
 * The cards a revision changed from the revision before it in its session, encoded for
 * `workflow_board_changes`: the added and changed ones in Plan order, then the removed ones. None
 * when it changed no card.
 */
export const boardChange = ({
  before,
  after,
}: {
  readonly before: MutableHashMap.MutableHashMap<string, string>;
  readonly after: MutableHashMap.MutableHashMap<string, string>;
}): Effect.Effect<Option.Option<string>, Schema.SchemaError> =>
  Arr.match(
    Arr.filterMap(after, ([id, json]) =>
      Option.contains(MutableHashMap.get(before, id), json) ? Result.failVoid : Result.succeed(id),
    ).concat(Arr.filter(MutableHashMap.keys(before), (id) => !MutableHashMap.has(after, id))),
    { onEmpty: () => Effect.succeedNone, onNonEmpty: (ids) => Effect.asSome(encodeCardIds(ids)) },
  );
const encodeGoal = Schema.encodeEffect(Schema.fromJsonString(GoalArtifact));
const encodePlan = Schema.encodeEffect(Schema.fromJsonString(PlanArtifact));
const encodeAuthor = Schema.encodeEffect(Schema.fromJsonString(BoardAuthor));
const encodeChange = Schema.encodeEffect(Schema.fromJsonString(UserChange));

/** The workflow store could not be read or written; the cause stays with the error. */
export class WorkflowStorageError extends Schema.TaggedError<
  WorkflowStorageError,
  { readonly brand: unique symbol }
>()("WorkflowStorageError", { cause: Schema.Defect() }) {}
const persisted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error: E): error is Extract<E, SqlError.SqlError | Schema.SchemaError> =>
      Predicate.isTagged(error, "SqlError") || Predicate.isTagged(error, "SchemaError"),
    (cause) => Effect.fail(WorkflowStorageError.make({ cause })),
  );
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(StartNewGoal));
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(StartNewGoal));

export class WorkflowTransitionRefused extends Schema.TaggedError<
  WorkflowTransitionRefused,
  { readonly brand: unique symbol }
>()("WorkflowTransitionRefused", { reason: WorkflowActionReason }) {}

/** `state` with the phase and statuses `standing` decided; a changed artifact is stamped `at`. */
const withStanding = (state: WorkflowState, standing: Standing, at: string): WorkflowState => ({
  ...state,
  phase: standing.phase,
  mode: standing.mode,
  goal:
    state.goal === null || standing.goal === null || standing.goal.status === state.goal.status
      ? state.goal
      : { ...state.goal, status: standing.goal.status, updatedAt: at },
  plan:
    state.plan === null || standing.plan === null || standing.plan.status === state.plan.status
      ? state.plan
      : { ...state.plan, status: standing.plan.status, updatedAt: at },
});
const unchanged = (next: WorkflowState, current: WorkflowState) =>
  next.phase === current.phase &&
  next.mode === current.mode &&
  next.goal === current.goal &&
  next.plan === current.plan;

/** A ledger's name for where a state is; shaping and running say whose approval they wait for. */
const placeText = ({ phase, mode }: WorkflowState) =>
  phase === "shaping" || phase === "running" ? `${phase} (${mode})` : phase;

const make = (options: { readonly allowNewGoal?: boolean } = {}) =>
  Effect.gen(function* () {
    const crypto = yield* SecureRandom.SecureRandom;
    const sql = yield* SqlClient.SqlClient;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    /**
     * One session's read-modify-write commits or rolls back as a whole. The transaction holds the
     * one connection, so it already runs alone; a key lock around it would deadlock a caller that
     * opened the transaction first.
     */
    const transacted = <A, E>(effect: Effect.Effect<A, E>) =>
      persisted(sql.withTransaction(effect));
    const stateJson = sql.literal(revisionStateSql("r"));
    const currentStates = sql.literal(currentStatesSql);
    const selectState = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ state_json: Schema.String }),
      execute: (sessionId) =>
        sql`SELECT ${stateJson} AS state_json FROM ${currentStates} WHERE w.session_id = ${sessionId}`,
    });
    const lastLedgerEvent = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ sequence: Schema.Finite }),
      execute: (sessionId) => sql`SELECT sequence FROM workflow_ledger_events
        WHERE session_id = ${sessionId} ORDER BY sequence DESC LIMIT 1`,
    });
    const latestPlan = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ plan_json: Schema.NullOr(Schema.String) }),
      execute: (sessionId) => sql`SELECT plan_json FROM workflow_state_revisions
        WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`,
    });
    const goalIdentity = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ goal_instance_id: Schema.String }),
      execute: (sessionId) =>
        sql`SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}`,
    });
    const latestRevision = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ id: Schema.Finite }),
      execute: (sessionId) => sql`SELECT id FROM workflow_state_revisions
        WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`,
    });
    const runOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ thread_id: Schema.String, status: Schema.String }),
      execute: (runId) => sql`SELECT thread_id, status FROM chat_runs WHERE run_id = ${runId}`,
    });
    const bindingOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({
        session_id: Schema.String,
        goal_instance_id: Schema.String,
        workflow_revision_id: Schema.Finite,
      }),
      execute: (runId) => sql`SELECT session_id, goal_instance_id, workflow_revision_id
        FROM workflow_run_bindings WHERE run_id = ${runId}`,
    });
    const requestOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ payload_json: Schema.String, status: Schema.String }),
      execute: (runId) =>
        sql`SELECT payload_json, status FROM workflow_new_goal_requests WHERE run_id = ${runId}`,
    });
    const settlementOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({
        session_id: Schema.String,
        payload_json: Schema.String,
        source_revision_id: Schema.Finite,
        status: Schema.Literals(["accepted", "applied", "rejected"]),
        reason: Schema.NullOr(NewGoalTransitionRefused.fields.reason),
        applied_goal_instance_id: Schema.NullOr(Schema.String),
      }),
      execute: (runId) => sql`SELECT session_id, payload_json, source_revision_id, status, reason,
        applied_goal_instance_id FROM workflow_new_goal_requests WHERE run_id = ${runId}`,
    });
    const exists = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
      Effect.map(statement, (rows) => rows.length > 0);
    const pendingNewGoal = (sessionId: string) =>
      exists(sql`SELECT run_id FROM workflow_new_goal_requests
        WHERE session_id = ${sessionId} AND status = 'accepted' LIMIT 1`);
    const insertGoalIdentity = (sessionId: string, goalInstanceId: string, now: string) =>
      sql`INSERT INTO workflow_goal_identities (session_id, goal_instance_id, created_at)
        VALUES (${sessionId}, ${goalInstanceId}, ${now})`;

    const get = (sessionId: string) =>
      selectState(sessionId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(emptyState()),
            onSome: (row) => decodeWorkflowState(row.state_json),
          }),
        ),
      );
    /** Board changes name their author; phase, Goal and lifecycle saves record none. */
    const save = Effect.fnUntraced(function* (
      sessionId: string,
      state: WorkflowState,
      author?: BoardAuthor,
    ) {
      const now = yield* nowIso;
      const goalJson = state.goal === null ? null : yield* encodeGoal(state.goal);
      const planJson = state.plan === null ? null : yield* encodePlan(state.plan);
      const authorJson = author === undefined ? null : yield* encodeAuthor(author);
      // The board's history: the cards this revision changes from the session's latest one.
      const change = yield* boardChange({
        before: yield* revisionCards(
          Option.match(yield* latestPlan(sessionId), {
            onNone: () => null,
            onSome: (row) => row.plan_json,
          }),
        ),
        after: yield* revisionCards(planJson),
      });
      // The ledger only grows: the events past the stored ones are this change's.
      const stored = Option.match(yield* lastLedgerEvent(sessionId), {
        onNone: () => 0,
        onSome: ({ sequence }) => sequence,
      });
      yield* Arr.match(
        state.ledger.filter((event) => event.sequence > stored),
        {
          onEmpty: () => Effect.void,
          onNonEmpty: (added) =>
            sql`INSERT INTO workflow_ledger_events ${sql.insert(
              Arr.map(added, ({ sequence, at, kind, detail }) => ({
                session_id: sessionId,
                sequence,
                at,
                kind,
                detail,
              })),
            )}`,
        },
      );
      yield* sql`INSERT INTO workflow_state_revisions
        (session_id, phase, mode, goal_json, plan_json, ledger_length, goal_version, plan_version,
         provenance, created_at, goal_instance_id, author_json)
        VALUES (${sessionId}, ${state.phase}, ${state.mode}, ${goalJson}, ${planJson},
          ${state.ledger.length},
          ${state.goal?.version ?? null}, ${state.plan?.version ?? null}, 'recorded', ${now},
          (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}),
          ${authorJson})`;
      // The revision just inserted on this connection.
      yield* sql`INSERT INTO session_workflows (session_id, revision_id, updated_at)
        VALUES (${sessionId}, last_insert_rowid(), ${now})
        ON CONFLICT(session_id) DO UPDATE SET revision_id = excluded.revision_id,
          updated_at = excluded.updated_at`;
      yield* Option.match(change, {
        onNone: () => Effect.void,
        onSome: (json) => sql`INSERT INTO workflow_board_changes
          (revision_id, session_id, card_ids_json)
          SELECT revision_id, session_id, ${json} FROM session_workflows
          WHERE session_id = ${sessionId}`,
      });
      return state;
    });
    const change = <E>(
      sessionId: string,
      update: (current: WorkflowState) => Effect.Effect<WorkflowState, E>,
      author?: BoardAuthor,
    ) =>
      transacted(
        Effect.gen(function* () {
          const current = yield* get(sessionId);
          const next = yield* update(current);
          return next === current ? current : yield* save(sessionId, next, author);
        }),
      );
    /** Whether the session's current Goal runs as an active kanban board. */
    const kanbanBoard = (sessionId: string) =>
      exists(sql`SELECT 1 AS active FROM kanban_goals k JOIN workflow_goal_identities g
        ON g.goal_instance_id = k.goal_instance_id
        WHERE g.session_id = ${sessionId} AND k.status = 'active'`);
    /**
     * A card id a Plan brings back, or whose work it replaces, names a new card: the earlier
     * card's failure streak, replans, hold reason and notes stay behind. Its agent starts a new
     * conversation on the earlier card's branch, as a card reassigned after a change does, and is
     * told the work there was done for the earlier card.
     */
    const renewReplacedCards = (
      sessionId: string,
      before: readonly PlanStep[],
      after: UpdatePlan["steps"],
    ) => {
      const previous = HashMap.fromIterable(Iterable.map(before, (step) => [step.id, step]));
      const replaced = after.flatMap((step) =>
        Option.exists(HashMap.get(previous, step.id), (prior) => sameStep(prior, step))
          ? []
          : [step.id],
      );
      return Arr.match(replaced, {
        onEmpty: () => Effect.void,
        onNonEmpty: (ids) =>
          Effect.flatMap(
            encodeNotes([
              "The planner rewrote this card. Changes already in your folder were made for its earlier version: keep only what this version needs.",
            ]),
            (notes) => sql`UPDATE kanban_cards SET failure_streak = 0, replans = 0,
                not_before = NULL, reason = NULL, notes_json = ${notes},
                generation = generation + 1
              WHERE goal_instance_id =
                  (SELECT goal_instance_id FROM workflow_goal_identities
                   WHERE session_id = ${sessionId})
                AND card_id IN ${sql.in(ids)}`,
          ),
      });
    };
    /**
     * The approval a card the planner adds now waits for: on a board running an approved Plan,
     * every new card it adds waits until the board's approval policy approves it. A card written
     * while shaping is approved with the Plan, even when an earlier approval left its board
     * active. A user's own cards never wait.
     */
    const approvalFor = (
      sessionId: string,
      current: WorkflowState,
      author: BoardAuthor | undefined,
      at: string,
    ) =>
      author === undefined || BoardAuthor.guards.User(author) || current.phase !== "running"
        ? Effect.succeedNone
        : Effect.map(kanbanBoard(sessionId), (kanban) =>
            kanban ? Option.some<CardApproval>({ requestedBy: author, at }) : Option.none(),
          );
    const event = (
      state: WorkflowState,
      kind: (typeof LedgerEvent.Type)["kind"],
      detail: string,
      at: string,
    ) => ({
      sequence: (state.ledger.at(-1)?.sequence ?? 0) + 1,
      at,
      kind,
      detail,
    });
    /** The state after a Plan ends without completion; the transition decided its `phase`. */
    const closing = (
      current: WorkflowState,
      plan: PlanArtifact,
      detail: string,
      at: string,
      phase: WorkflowPhase,
    ): WorkflowState => {
      const closed: WorkflowState = {
        ...current,
        phase,
        plan: { ...plan, updatedAt: at },
        ledger: [...current.ledger, event(current, "plan_closed", detail, at)],
      };
      return phase === current.phase
        ? closed
        : {
            ...closed,
            ledger: [
              ...closed.ledger,
              event(closed, "phase_changed", `${current.phase} -> ${phase} (plan closed)`, at),
            ],
          };
    };
    /** The state of `current`, a conflict 0.0.17 left repaired in memory. */
    const goalState = (current: WorkflowState) => goalStateOf(standingOf(current));
    /** `current` with a conflict repaired and a stale progress position corrected. */
    const reconciledState = (current: WorkflowState, now: string) => {
      const repaired = goalState(current).standing;
      return withStanding(current, { ...repaired, phase: reconciledPhase(repaired) }, now);
    };
    /** `current` reconciled, saved if changed. */
    const reconciled = Effect.fnUntraced(function* (sessionId: string, current: WorkflowState) {
      const now = yield* nowIso;
      const next = reconciledState(current, now);
      if (unchanged(next, current)) return current;
      return yield* save(sessionId, {
        ...next,
        ledger: [
          ...next.ledger,
          event(
            current,
            "phase_changed",
            `${current.phase} -> ${next.phase} (state reconciled)`,
            now,
          ),
        ],
      });
    });
    const refuseNewGoal = (reason: NewGoalTransitionRefused["reason"]) =>
      Effect.fail(NewGoalTransitionRefused.make({ reason }));
    // Used both at tool admission and again at the completed-run owner boundary.
    // Only admission may exclude its own (still running) run; application excludes none.
    const checkNewGoal = Effect.fnUntraced(function* (
      sessionId: string,
      input: StartNewGoal,
      request: Extract<GoalEvent, { readonly _tag: "NewGoalRequested" | "NewGoalStarted" }>,
      callingRunId?: string,
    ) {
      if (options.allowNewGoal === false) return yield* refuseNewGoal("disabled");
      const current = yield* get(sessionId);
      const state = goalState(current);
      const source = Match.valueTags(request, {
        NewGoalRequested: (requested) => goalTransitions.NewGoalRequested(state, requested),
        NewGoalStarted: (started) => goalTransitions.NewGoalStarted(state, started),
      });
      if (source._tag === "Refused") return yield* refuseNewGoal(source.reason);
      const identity = yield* goalIdentity(sessionId);
      if (
        Option.getOrNull(Option.map(identity, (row) => row.goal_instance_id)) !==
        input.previousGoalInstanceId
      )
        return yield* refuseNewGoal("workflow_changed");
      const caller = callingRunId ?? "";
      if (
        (yield* exists(sql`
          SELECT b.run_id FROM workflow_run_bindings b LEFT JOIN chat_runs r ON r.run_id = b.run_id
          WHERE b.session_id = ${sessionId} AND b.run_id <> ${caller}
            AND (r.status IS NULL OR r.status <> 'completed')
            AND NOT ${sql.literal(resolvedRunSql("b", "r"))} LIMIT 1`)) ||
        (yield* exists(sql`
          SELECT r.run_id FROM chat_runs r WHERE r.thread_id = ${sessionId} AND r.run_id <> ${caller}
            AND r.status <> 'completed'
            AND NOT EXISTS (SELECT 1 FROM workflow_run_bindings b
              WHERE b.run_id = r.run_id AND ${sql.literal(resolvedRunSql("b", "r"))}) LIMIT 1`))
      )
        return yield* refuseNewGoal("run_outcome_uncertain");
      if (
        yield* exists(sql`
          SELECT o.run_id FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id = o.run_id
          WHERE b.session_id = ${sessionId}
            AND ((o.status = 'pending' AND o.run_id <> ${caller}) OR (o.side_effect = 1 AND o.status = 'uncertain'))
            AND NOT ${sql.literal(acknowledgedRunSql("b"))} LIMIT 1`)
      )
        return yield* refuseNewGoal("owner_effect_uncertain");
      if (
        yield* exists(sql`SELECT id FROM work_tasks WHERE origin_session_id = ${sessionId}
          AND status NOT IN ('completed', 'archived') LIMIT 1`)
      )
        return yield* refuseNewGoal("execution_outstanding");
      return { current, identity, standing: source.standing };
    });
    const commitNewGoal = Effect.fnUntraced(function* (sessionId: string, input: StartNewGoal) {
      const { current, identity, standing } = yield* checkNewGoal(
        sessionId,
        input,
        GoalEvent.NewGoalStarted({ status: input.goal.status }),
      );
      const now = yield* nowIso;
      const newId = yield* crypto.uuidV4();
      // An unbound legacy Goal never receives a fabricated historical identity.
      yield* Option.isSome(identity)
        ? Effect.andThen(
            sql`INSERT INTO workflow_goal_instances VALUES (${newId}, ${sessionId}, ${now})`,
            sql`UPDATE workflow_goal_identities SET goal_instance_id = ${newId}, created_at = ${now}
              WHERE session_id = ${sessionId}`,
          )
        : insertGoalIdentity(sessionId, newId, now);
      yield* save(sessionId, {
        phase: standing.phase,
        mode: standing.mode,
        goal: {
          ...input.goal,
          version: 1,
          evidence: [],
          verification: verificationDefault,
          updatedAt: now,
        },
        plan: null,
        ledger: [
          ...current.ledger,
          event(
            current,
            "goal_updated",
            `explicit new Goal ${newId}; prior ${input.previousGoalInstanceId ?? "legacy/unbound"}; ${input.reason}`,
            now,
          ),
        ],
      });
      return newId;
    });
    /**
     * Idempotent owner settlement of a run's new Goal request. A run `waiting` may still finish, so
     * its request stays accepted; a failed or missing run can never apply its intent.
     */
    const settleRequest = (
      sessionId: string,
      runId: string,
      waiting: (run: { readonly status: string }) => boolean,
    ) =>
      transacted(
        Effect.gen(function* () {
          const found = yield* settlementOf(runId);
          if (Option.isNone(found) || found.value.session_id !== sessionId)
            return NewGoalSettlement.none();
          const row = found.value;
          if (row.status === "applied")
            return NewGoalSettlement.applied({ goalInstanceId: row.applied_goal_instance_id });
          if (row.status === "rejected") return NewGoalSettlement.rejected({ reason: row.reason });
          const run = Option.getOrUndefined(yield* runOf(runId));
          if (run?.thread_id === sessionId && waiting(run)) return NewGoalSettlement.accepted();
          const reject = (reason: NewGoalTransitionRefused["reason"]) =>
            nowIso.pipe(
              Effect.flatMap(
                (
                  now,
                ) => sql`UPDATE workflow_new_goal_requests SET status = 'rejected', reason = ${reason},
              settled_at = ${now} WHERE run_id = ${runId} AND status = 'accepted'`,
              ),
              Effect.as(NewGoalSettlement.rejected({ reason })),
            );
          if (run?.thread_id !== sessionId || run.status !== "completed")
            return yield* reject("run_outcome_uncertain");
          const latest = yield* latestRevision(sessionId);
          if (Option.getOrUndefined(latest)?.id !== row.source_revision_id)
            return yield* reject("workflow_changed");
          const input = yield* decodeRequest(row.payload_json);
          return yield* commitNewGoal(sessionId, input).pipe(
            Effect.flatMap((newId) =>
              nowIso.pipe(
                Effect.flatMap(
                  (now) => sql`UPDATE workflow_new_goal_requests
                SET status = 'applied', applied_goal_instance_id = ${newId}, settled_at = ${now}
                WHERE run_id = ${runId} AND status = 'accepted'`,
                ),
                Effect.as(NewGoalSettlement.applied({ goalInstanceId: newId })),
              ),
            ),
            Effect.catchTag("NewGoalTransitionRefused", (error) => reject(error.reason)),
          );
        }),
      );
    const storedStates = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ session_id: Schema.String, state_json: Schema.String }),
      execute: () => sql`SELECT w.session_id, ${stateJson} AS state_json FROM ${currentStates}
        ORDER BY w.session_id`,
    });
    const acceptedRequests = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ session_id: Schema.String, run_id: Schema.String }),
      execute: () => sql`SELECT session_id, run_id FROM workflow_new_goal_requests
        WHERE status = 'accepted' ORDER BY run_id`,
    });

    /** The standing after a board change to `plan`; `closes` when it ends the Plan. */
    const boardEdited = (current: WorkflowState, plan: PlanArtifact, closes: boolean) => {
      const outcome = goalTransitions.BoardEdited(
        goalState(current),
        GoalEvent.BoardEdited({ closes, ...stepsOf(plan.steps) }),
      );
      return outcome._tag === "Refused"
        ? Effect.fail(BoardEditRefused.make({ reason: outcome.reason }))
        : Effect.succeed(outcome.standing);
    };
    /** `current` with a board change to its cards, recorded in the ledger. */
    const boardChanged = (
      current: WorkflowState,
      planned: { readonly plan: PlanArtifact; readonly detail: string },
      at: string,
    ) =>
      Effect.map(boardEdited(current, planned.plan, false), (standing) =>
        withStanding(
          {
            ...current,
            plan: { ...planned.plan, updatedAt: at },
            ledger: [...current.ledger, event(current, "board_updated", planned.detail, at)],
          },
          standing,
          at,
        ),
      );

    const goalAtVersion = SqlSchema.findOneOption({
      Request: Schema.Struct({ sessionId: Schema.String, version: Schema.Int }),
      Result: Schema.Struct({ goal_json: Schema.fromJsonString(GoalArtifact) }),
      execute: ({ sessionId, version }) => sql`SELECT goal_json FROM workflow_state_revisions
        WHERE session_id = ${sessionId} AND goal_version = ${version}
          AND goal_instance_id = (SELECT goal_instance_id FROM workflow_goal_identities
            WHERE session_id = ${sessionId})
        ORDER BY id DESC LIMIT 1`,
    });

    return {
      get: (sessionId: string) => persisted(get(sessionId)),
      /** The session's current Goal as it stood at `version`; none when no revision holds it. */
      goalAt: (sessionId: string, version: number) =>
        persisted(
          Effect.map(
            goalAtVersion({ sessionId, version }),
            Option.map((row) => row.goal_json),
          ),
        ),
      goalInstanceId: (sessionId: string) =>
        persisted(
          goalIdentity(sessionId).pipe(
            Effect.map((row) =>
              Option.getOrNull(Option.map(row, (found) => found.goal_instance_id)),
            ),
          ),
        ),

      /** Repairs stale persisted phases before a new turn or an idle status response. */
      reconcile: (sessionId: string) =>
        // A state that needs no repair is only read. The write transaction, which waits for any
        // other writer while it holds the app's one connection, is for a repair alone.
        Effect.flatMap(persisted(get(sessionId)), (current) =>
          Effect.flatMap(nowIso, (now) =>
            unchanged(reconciledState(current, now), current)
              ? Effect.succeed(current)
              : transacted(Effect.flatMap(get(sessionId), (fresh) => reconciled(sessionId, fresh))),
          ),
        ),

      /**
       * What the page says beside `state` that the state alone does not show: a kanban Goal edit
       * keeps the phase while the orchestrator sorts the cards again for the new Goal version.
       */
      display: (
        sessionId: string,
        state: WorkflowState,
      ): Effect.Effect<WorkflowDisplay | null, WorkflowStorageError> =>
        goalStateOf(standingOf(state))._tag === "GoalChanged"
          ? Effect.map(persisted(kanbanBoard(sessionId)), (kanban) =>
              kanban ? "card_reclassifying" : null,
            )
          : Effect.succeed(null),

      /**
       * Repairs every session whose stored Goal and Plan no transition makes, and returns their ids.
       * An active kanban board's orchestrator still uses its Plan, so its session is only logged.
       */
      checkAll: persisted(storedStates()).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, ({ session_id: sessionId, state_json: json }) =>
            decodeWorkflowState(json).pipe(
              Effect.flatMap((current) =>
                Result.isSuccess(decodeGoalState(standingOf(current)))
                  ? Effect.succeed([])
                  : Effect.flatMap(persisted(kanbanBoard(sessionId)), (kanban) =>
                      kanban
                        ? Effect.as(
                            Effect.logWarning("Kanban Goal left in a conflicting state", {
                              sessionId,
                            }),
                            [],
                          )
                        : Effect.as(
                            transacted(
                              Effect.flatMap(get(sessionId), (stored) =>
                                reconciled(sessionId, stored),
                              ),
                            ),
                            [sessionId],
                          ),
                    ),
              ),
              Effect.catch((error) =>
                Effect.as(
                  logFailure("Workflow state unreadable at startup", { sessionId })(error),
                  [],
                ),
              ),
            ),
          ),
        ),
        Effect.map((repaired) => repaired.flat()),
      ),

      /** Works in a mode the user chose, or runs the approved Plan (`run`). */
      move: (sessionId: string, move: WorkflowMove) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const state = goalState(current);
            const outcome =
              move === "run"
                ? goalTransitions.ExecutionApproved(state, GoalEvent.ExecutionApproved())
                : goalTransitions.Navigated(state, GoalEvent.Navigated({ to: move }));
            if (outcome._tag === "Refused")
              return yield* WorkflowTransitionRefused.make({ reason: outcome.reason });
            const now = yield* nowIso;
            const next = withStanding(current, outcome.standing, now);
            return yield* save(sessionId, {
              ...next,
              ledger: [
                ...next.ledger,
                event(current, "phase_changed", `${placeText(current)} -> ${placeText(next)}`, now),
              ],
            });
          }),
        ),

      controlGoal: (sessionId: string, action: WorkflowAction) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const state = goalState(current);
            const outcome = Match.value(action).pipe(
              Match.when("pause", () => goalTransitions.GoalPaused(state, GoalEvent.GoalPaused())),
              Match.when("resume", () =>
                goalTransitions.GoalResumed(state, GoalEvent.GoalResumed()),
              ),
              Match.when("stop", () => goalTransitions.GoalStopped(state, GoalEvent.GoalStopped())),
              Match.exhaustive,
            );
            if (outcome._tag === "Refused")
              return yield* WorkflowTransitionRefused.make({ reason: outcome.reason });
            const now = yield* nowIso;
            const kind =
              action === "pause"
                ? "goal_paused"
                : action === "resume"
                  ? "goal_resumed"
                  : "workflow_stopped";
            const detail =
              action === "pause"
                ? "Paused by the user"
                : action === "resume"
                  ? "Resumed by the user"
                  : "Stopped by the user";
            const next = withStanding(current, outcome.standing, now);
            return yield* save(sessionId, {
              ...next,
              ledger: [...next.ledger, event(current, kind, detail, now)],
            });
          }),
        ),

      /** Tool admission only records a durable request; never claims a new Goal was saved. */
      requestNewGoal: (sessionId: string, runId: string, input: StartNewGoal) =>
        transacted(
          Effect.gen(function* () {
            const payload = yield* encodeRequest(input);
            const existing = yield* requestOf(runId);
            if (Option.isSome(existing)) {
              // Compare canonical encodings so a request stored with another key order still matches.
              const stored = yield* encodeRequest(
                yield* decodeRequest(existing.value.payload_json),
              );
              if (stored === payload && existing.value.status === "accepted")
                return { status: "accepted" as const, runId };
              return yield* refuseNewGoal("transition_pending");
            }
            const run = Option.getOrUndefined(yield* runOf(runId));
            if (!(runId.length > 0) || run?.thread_id !== sessionId || run.status !== "running")
              return yield* refuseNewGoal("run_outcome_uncertain");
            if (yield* pendingNewGoal(sessionId)) return yield* refuseNewGoal("transition_pending");
            yield* checkNewGoal(sessionId, input, GoalEvent.NewGoalRequested(), runId);
            const binding = Option.getOrUndefined(yield* bindingOf(runId));
            const revision = yield* latestRevision(sessionId);
            if (
              Option.isNone(revision) ||
              (binding !== undefined &&
                (binding.session_id !== sessionId ||
                  binding.goal_instance_id !== input.previousGoalInstanceId ||
                  binding.workflow_revision_id !== revision.value.id))
            )
              return yield* refuseNewGoal("workflow_changed");
            yield* sql`INSERT INTO workflow_new_goal_requests
            (run_id, session_id, previous_goal_instance_id, source_revision_id,
             payload_json, status, created_at)
            VALUES (${runId}, ${sessionId}, ${input.previousGoalInstanceId}, ${revision.value.id},
              ${payload}, 'accepted', ${yield* nowIso})`;
            return { status: "accepted" as const, runId };
          }),
        ).pipe(
          Effect.tapErrorTag("NewGoalTransitionRefused", ({ reason }) =>
            Effect.logWarning("New Goal request refused", { sessionId, runId, reason }),
          ),
        ),

      /** Idempotent owner settlement. A failed or missing run can never apply its intent. */
      settleNewGoalRequest: (sessionId: string, runId: string) =>
        settleRequest(
          sessionId,
          runId,
          // A run waiting for an approval in this process settles once it finishes.
          ({ status }) => status === "running" || status === "interrupted",
        ),

      /**
       * Settles every accepted request at startup. No run of an earlier process can still finish, so
       * only a completed run applies its request. Returns how many were settled.
       */
      settleAbandonedNewGoalRequests: persisted(acceptedRequests()).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, ({ session_id: sessionId, run_id: runId }) =>
            settleRequest(sessionId, runId, () => false),
          ),
        ),
        Effect.map((settled) => settled.length),
      ),

      updateGoal: (sessionId: string, input: UpdateGoal) =>
        change(sessionId, (current) =>
          Effect.gen(function* () {
            const now = yield* nowIso;
            // Only the first Goal in a new session is unambiguously new. A legacy Goal
            // without a recorded identity stays unbound; guessing it from text is unsafe.
            yield* Effect.when(
              Effect.flatMap(crypto.uuidV4(), (goalInstanceId) =>
                insertGoalIdentity(sessionId, goalInstanceId, now),
              ),
              Effect.succeed(current.goal === null),
            );
            const goal: GoalArtifact = {
              ...input,
              evidence: [],
              verification: verificationDefault,
              version: (current.goal?.version ?? 0) + 1,
              updatedAt: now,
            };
            // A kanban board keeps executing: its orchestrator classifies each card against the new
            // Goal instead (docs/kanban-orchestration.md "식별자와 Goal 변경").
            const { standing } = goalTransitions.GoalEdited(
              goalState(current),
              GoalEvent.GoalEdited({ status: input.status, kanban: yield* kanbanBoard(sessionId) }),
            );
            const revised = withStanding(
              {
                ...current,
                goal,
                ledger: [
                  ...current.ledger,
                  event(current, "goal_updated", `goal v${goal.version} (${goal.status})`, now),
                ],
              },
              standing,
              now,
            );
            return revised.phase === current.phase
              ? revised
              : {
                  ...revised,
                  ledger: [
                    ...revised.ledger,
                    event(
                      revised,
                      "phase_changed",
                      `${current.phase} -> ${revised.phase} (goal revised)`,
                      now,
                    ),
                  ],
                };
          }),
        ),

      updatePlan: (sessionId: string, input: UpdatePlan, author?: BoardAuthor) =>
        validatePlanDependencies(input.steps).pipe(
          Effect.andThen(() =>
            change(
              sessionId,
              (current) =>
                validateStepOutcomes(current.goal?.outcomes ?? [], input.steps).pipe(
                  Effect.andThen(nowIso),
                  Effect.bindTo("now"),
                  Effect.bind("approval", ({ now }) =>
                    approvalFor(sessionId, current, author, now),
                  ),
                  Effect.map(({ now, approval }) => {
                    const previous = HashMap.fromIterable(
                      Iterable.map(current.plan?.steps ?? [], (step) => [step.id, step]),
                    );
                    const plan: PlanArtifact = {
                      ...input,
                      steps: cardStatuses(
                        input.steps.map((step) => {
                          const replanned = { ...step, status: "pending" as const, evidence: [] };
                          const prior = Option.getOrUndefined(HashMap.get(previous, step.id));
                          return prior === undefined
                            ? {
                                ...replanned,
                                ...optionalProperty("approval", Option.getOrUndefined(approval)),
                              }
                            : {
                                ...cardContract(prior),
                                ...optionalProperty("hold", prior.hold),
                                ...optionalProperty("approval", prior.approval),
                                ...step,
                                ...replannedProgress(prior, step),
                              };
                        }),
                      ),
                      evidence: [],
                      verification: verificationDefault,
                      version: (current.plan?.version ?? 0) + 1,
                      goalVersion: current.goal?.version ?? 0,
                      updatedAt: now,
                    };
                    const { standing } = goalTransitions.PlanEdited(
                      goalState(current),
                      GoalEvent.PlanEdited({ status: input.status, ...stepsOf(plan.steps) }),
                    );
                    const kind = current.plan === null ? "plan_updated" : "plan_replanned";
                    const planned = withStanding(
                      {
                        ...current,
                        plan,
                        ledger: [
                          ...current.ledger,
                          event(current, kind, `plan v${plan.version} (${plan.status})`, now),
                        ],
                      },
                      standing,
                      now,
                    );
                    return planned.phase === current.phase
                      ? planned
                      : {
                          ...planned,
                          ledger: [
                            ...planned.ledger,
                            event(
                              planned,
                              "phase_changed",
                              `${current.phase} -> ${planned.phase} (plan revised)`,
                              now,
                            ),
                          ],
                        };
                  }),
                  Effect.tap(() =>
                    renewReplacedCards(sessionId, current.plan?.steps ?? [], input.steps),
                  ),
                ),
              author,
            ),
          ),
        ),

      /**
       * Completes the Goal and its Plan once the verifier judged every outcome met. `met` are the
       * standings it judged, for the Goal and Plan versions it read; a later version, or a Goal
       * that may not complete now, is left as it is for the next look. True when it completed.
       */
      completeFromOutcomes: (
        sessionId: string,
        judged: {
          readonly goalVersion: number;
          readonly planVersion: number;
          readonly met: ReadonlyArray<{ readonly outcomeId: string; readonly summary: string }>;
        },
        author: BoardAuthor,
      ) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            if (
              current.goal?.version !== judged.goalVersion ||
              current.plan?.version !== judged.planVersion
            )
              return false;
            const outcome = goalTransitions.OutcomesMet(
              goalState(current),
              GoalEvent.OutcomesMet(),
            );
            if (outcome._tag === "Refused") return false;
            const now = yield* nowIso;
            const verification = {
              status: "passed" as const,
              summary: "The verifier judged every Goal outcome met.",
              evidence: judged.met.map(({ outcomeId, summary }) => `${outcomeId}: ${summary}`),
              recoveryPhase: null,
              updatedAt: now,
            };
            const next = withStanding(
              {
                ...current,
                goal: { ...current.goal, verification, updatedAt: now },
                plan: { ...current.plan, verification, updatedAt: now },
              },
              outcome.standing,
              now,
            );
            const verified = event(
              current,
              "verification_recorded",
              `goal completed: outcomes ${judged.met.map(({ outcomeId }) => outcomeId).join(", ")} met`,
              now,
            );
            const ledger = [...current.ledger, verified];
            yield* save(
              sessionId,
              {
                ...next,
                ledger:
                  next.phase === current.phase
                    ? ledger
                    : [
                        ...ledger,
                        event(
                          { ...current, ledger },
                          "phase_changed",
                          `${current.phase} -> ${next.phase} (goal completed)`,
                          now,
                        ),
                      ],
              },
              author,
            );
            return true;
          }),
        ),

      /**
       * Ends the Plan without completing it, with the author's reason. Refused when there is no
       * Plan or it already ended.
       */
      closePlan: (sessionId: string, reason: string, author?: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const outcome = goalTransitions.PlanClosed(goalState(current), GoalEvent.PlanClosed());
            if (outcome._tag === "Refused")
              return yield* BoardEditRefused.make({ reason: outcome.reason });
            // The transition refused a missing Plan; this narrows its type.
            if (current.plan === null)
              return yield* BoardEditRefused.make({ reason: "plan_missing" });
            const detail = `plan v${current.plan.version} closed: ${reason}`;
            return yield* save(
              sessionId,
              closing(
                current,
                closedPlan(current.plan),
                detail,
                yield* nowIso,
                outcome.standing.phase,
              ),
              author,
            );
          }),
        ),

      /**
       * Saves a board change with its author. A user's change to an executing card is stored as a
       * pending request for the orchestrator and leaves the card as it is.
       */
      editBoard: (sessionId: string, edit: BoardEdit, author: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const cardId = `card-${(yield* crypto.uuidV4()).slice(0, 8)}`;
            const planned = yield* planBoardEdit(
              current.plan,
              current.goal?.outcomes ?? [],
              edit,
              author,
              cardId,
            );
            const now = yield* nowIso;
            return yield* Match.valueTags(planned, {
              Apply: Effect.fnUntraced(function* (change) {
                const next = yield* boardChanged(current, change, now);
                return BoardEditResult.Applied({ state: yield* save(sessionId, next, author) });
              }),
              Request: Effect.fnUntraced(function* ({ cardId, change }) {
                const changeJson = yield* encodeChange(change);
                const inserted = yield* sql<{
                  readonly id: number;
                }>`INSERT INTO board_change_requests
                (session_id, goal_instance_id, card_id, plan_version, change_json, status, created_at)
                VALUES (${sessionId},
                  (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ${sessionId}),
                  ${cardId}, ${edit.planVersion}, ${changeJson}, 'pending', ${now})
                RETURNING id`;
                const request: UserChangeRequest = {
                  id: Number(inserted[0]?.id),
                  cardId,
                  planVersion: edit.planVersion,
                  change,
                  status: "pending",
                  reason: null,
                  createdAt: now,
                };
                return BoardEditResult.Requested({ request });
              }),
              Close: Effect.fnUntraced(function* ({ plan, detail }) {
                const standing = yield* boardEdited(current, plan, true);
                const next = closing(current, plan, detail, now, standing.phase);
                return BoardEditResult.Applied({ state: yield* save(sessionId, next, author) });
              }),
            });
          }),
        ),

      /**
       * Applies a run's step edits in order to the Plan version it read and saves the result as
       * one next version. A refused edit saves none of them.
       */
      editPlan: (sessionId: string, input: EditPlan, author: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const approval = yield* approvalFor(sessionId, current, author, yield* nowIso);
            const edited = yield* Effect.reduce(
              input.edits,
              () => ({
                plan: current.plan,
                version: input.planVersion,
                details: Chunk.empty<string>(),
              }),
              (done, planEdit) => {
                const { edit, newCardId } = boardEditOf(planEdit, done.version);
                return Effect.flatMap(
                  planBoardEdit(
                    done.plan,
                    current.goal?.outcomes ?? [],
                    edit,
                    author,
                    newCardId,
                    Option.getOrUndefined(approval),
                  ),
                  (planned) =>
                    BoardEditPlan.$match(planned, {
                      Apply: ({ plan, detail }) =>
                        Effect.succeed({
                          plan,
                          version: plan.version,
                          details: Chunk.append(done.details, detail),
                        }),
                      // A run's own change never waits for the orchestrator, and no edit closes.
                      Request: () => Effect.die("a run's Plan edit was stored as a request"),
                      Close: () => Effect.die("a run's Plan edit closed the Plan"),
                    }),
                );
              },
            );
            // Every applied edit had a Plan, so only an edit list that applied none leaves it null.
            if (edited.plan === null)
              return yield* BoardEditRefused.make({ reason: "plan_missing" });
            const next = yield* boardChanged(
              current,
              {
                plan: { ...edited.plan, version: input.planVersion + 1 },
                detail: Chunk.toReadonlyArray(edited.details).join("; "),
              },
              yield* nowIso,
            );
            return yield* save(sessionId, next, author);
          }),
        ),

      /** Puts a card not started yet on hold, or releases it; recorded with its author. */
      holdCard: (
        sessionId: string,
        change: { readonly cardId: string; readonly hold: boolean },
        author: BoardAuthor,
      ) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const now = yield* nowIso;
            const planned = yield* planCardHold(current.plan, change, author, now);
            return yield* save(sessionId, yield* boardChanged(current, planned, now), author);
          }),
        ),

      /**
       * Approves cards the planner added, or records why the auto mode's reviewer left them to the
       * user. Recorded with its author.
       */
      settleCardApproval: (
        sessionId: string,
        cardIds: readonly string[],
        change: CardApprovalChange,
        author: BoardAuthor,
      ) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const now = yield* nowIso;
            const planned = yield* planCardApproval(current.plan, cardIds, change);
            return yield* save(sessionId, yield* boardChanged(current, planned, now), author);
          }),
        ),

      /**
       * Moves a card's status with its author. Refused when the card is no longer in `from`, so
       * two authors racing for the same card cannot both win.
       */
      transitionCard: (sessionId: string, transition: CardTransition, author: BoardAuthor) =>
        transacted(
          Effect.gen(function* () {
            const current = yield* get(sessionId);
            const planned = yield* planCardTransition(current.plan, transition);
            const now = yield* nowIso;
            return yield* save(sessionId, yield* boardChanged(current, planned, now), author);
          }),
        ),
    };
  });

/** Versioned Goal/Plan artifacts and their execution ledger, scoped to a session. */
export class Workflows extends Context.Service<
  Workflows,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/workflow/workflow/Workflows") {
  static readonly layer = Layer.effect(Workflows, make()).pipe(Layer.provide(NodeCrypto.layer));
  /** Compatible code rollback disables only the new action; never deletes history or lowers schema. */
  static readonly layerWithOptions = (options: { readonly allowNewGoal: boolean }) =>
    Layer.effect(Workflows, make(options)).pipe(Layer.provide(NodeCrypto.layer));
}
