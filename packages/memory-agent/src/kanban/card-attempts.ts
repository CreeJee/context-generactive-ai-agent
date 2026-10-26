import { Clock, Context, DateTime, Effect, Layer, Option, PubSub, Schema, Stream } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { endedWithKnownEffectsSql } from "../workflow/run-bindings.ts";
import { UserChange, UserChangeRequestStatus } from "../workflow/board-edit.ts";
import { CardStatus } from "../workflow/card.ts";
import { CardFailure, CardHoldReason } from "./failures.ts";

/**
 * Durable kanban execution records on the owner connection: which Goal instances run as a board,
 * each card attempt (one DurableQueue item) and its outcome, the agent runs a delivery started, and
 * the failure ladder of each card (docs/kanban-orchestration.md "큐", "오케스트레이터 루프").
 */

/** What a card attempt ended with. The queue handler records it; the orchestrator takes it up. */
export const CardAttemptOutcome = Schema.TaggedUnion({
  /** The agent finished; its work is committed to the card branch when there was any. */
  Completed: {
    report: Schema.String,
    commit: Schema.NullOr(Schema.String),
  },
  /** The agent or the card's worktree failed. */
  Failed: { failure: CardFailure },
  /** An earlier run of the card may have had an effect nobody knows; nothing ran. */
  Fenced: { runId: Schema.String },
  /** The session moved to another Goal instance before the item ran; nothing ran. */
  Superseded: {},
  /** The card left in_progress, or the orchestrator stopped the attempt. */
  Stopped: { cardStatus: Schema.NullOr(CardStatus) },
});
export type CardAttemptOutcome = typeof CardAttemptOutcome.Type;

/** A Goal instance stopped by the orchestrator until its cards are classified against a new Goal. */
export const AssignmentHold = Schema.TaggedStruct("GoalChanged", {
  fromVersion: Schema.Int,
  toVersion: Schema.Int,
});
export type AssignmentHold = typeof AssignmentHold.Type;

export const KanbanMode = Schema.Literals(["worktree", "sequential"]);
export type KanbanMode = typeof KanbanMode.Type;

export interface KanbanGoal {
  readonly goalInstanceId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  /** `sequential` when the project cannot have worktrees: one card at a time in the project. */
  readonly mode: KanbanMode;
  /** The Goal version the board was last classified against. */
  readonly goalVersion: number;
  readonly hold: AssignmentHold | null;
  readonly active: boolean;
}

export interface CardAttemptKey {
  readonly goalInstanceId: string;
  readonly cardId: string;
  readonly attemptNo: number;
}

export interface CardAttempt extends CardAttemptKey {
  readonly sessionId: string;
  readonly goalVersion: number;
  readonly planVersion: number;
  readonly outcome: CardAttemptOutcome | null;
  readonly handled: boolean;
}

/** Where a card stands on its failure ladder and how its agent conversation is named. */
export interface CardLadder {
  readonly failureStreak: number;
  readonly replans: number;
  readonly generation: number;
  /** Clock milliseconds before which the card is not assigned again. */
  readonly notBefore: number | null;
  readonly reason: CardHoldReason | null;
  readonly resolutionOf: string | null;
  /** Changes applied to the card that its next attempt is told about. */
  readonly notes: readonly string[];
}

/** A card attempt whose queue item ran out of deliveries. */
export interface DeadLetteredAttempt extends CardAttemptKey {
  readonly itemId: string;
}

export const KanbanStorageReason = Schema.TaggedUnion({
  /** The database or a stored row failed; `cause` has the SQL or decode error. */
  Storage: {},
  /** A value the owner made did not encode for storage. */
  Encode: {},
  /** A record the owner just stored or read is not there. */
  Missing: {},
});
export type KanbanStorageReason = typeof KanbanStorageReason.Type;

export class KanbanStorageFailed extends Schema.TaggedError<KanbanStorageFailed>()(
  "KanbanStorageFailed",
  {
    operation: Schema.Literals([
      "goal",
      "attempt",
      "run",
      "card",
      "dead_letters",
      "change_request",
      "decision",
    ]),
    reason: KanbanStorageReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const GoalRow = Schema.Struct({
  goal_instance_id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  project_root: Schema.String,
  mode: KanbanMode,
  goal_version: Schema.Int,
  hold_json: Schema.NullOr(Schema.fromJsonString(AssignmentHold)),
  status: Schema.Literals(["active", "stopped"]),
});
const AttemptRow = Schema.Struct({
  goal_instance_id: Schema.String,
  card_id: Schema.String,
  attempt_no: Schema.Int,
  session_id: Schema.String,
  goal_version: Schema.Int,
  plan_version: Schema.Int,
  outcome_json: Schema.NullOr(Schema.fromJsonString(CardAttemptOutcome)),
  handled: Schema.Literals([0, 1]),
});
const CardRow = Schema.Struct({
  failure_streak: Schema.Int,
  replans: Schema.Int,
  generation: Schema.Int,
  not_before: Schema.NullOr(Schema.Finite),
  reason: Schema.NullOr(Schema.fromJsonString(CardHoldReason)),
  resolution_of: Schema.NullOr(Schema.String),
  notes_json: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const NumberRow = Schema.Struct({ value: Schema.NullOr(Schema.Finite) });
const ChangeRequestRow = Schema.Struct({
  id: Schema.Int,
  card_id: Schema.String,
  change_json: Schema.fromJsonString(UserChange),
  status: UserChangeRequestStatus,
});
const RunRow = Schema.Struct({ run_id: Schema.String });
const RequestRow = Schema.Struct({ request_id: Schema.String });
const DeadRow = Schema.Struct({
  id: Schema.String,
  goal_instance_id: Schema.NullOr(Schema.String),
  card_id: Schema.NullOr(Schema.String),
  attempt_no: Schema.NullOr(Schema.Int),
});
const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(CardAttemptOutcome));
const encodeHold = Schema.encodeEffect(Schema.fromJsonString(AssignmentHold));
const encodeNotes = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeReason = Schema.encodeEffect(Schema.NullOr(Schema.fromJsonString(CardHoldReason)));

const toGoal = (row: typeof GoalRow.Type): KanbanGoal => ({
  goalInstanceId: row.goal_instance_id,
  sessionId: row.session_id,
  projectId: row.project_id,
  projectRoot: row.project_root,
  mode: row.mode,
  goalVersion: row.goal_version,
  hold: row.hold_json,
  active: row.status === "active",
});
const toAttempt = (row: typeof AttemptRow.Type): CardAttempt => ({
  goalInstanceId: row.goal_instance_id,
  cardId: row.card_id,
  attemptNo: row.attempt_no,
  sessionId: row.session_id,
  goalVersion: row.goal_version,
  planVersion: row.plan_version,
  outcome: row.outcome_json,
  handled: row.handled === 1,
});
const freshLadder: CardLadder = {
  failureStreak: 0,
  replans: 0,
  generation: 1,
  notBefore: null,
  reason: null,
  resolutionOf: null,
  notes: [],
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Clock.currentTimeMillis;
  // Goal instances with a newly recorded outcome, for whoever waits on them in this process.
  const recorded = yield* PubSub.unbounded<string>();
  const failed =
    (operation: KanbanStorageFailed["operation"]) =>
    (cause: SqlError.SqlError | Schema.SchemaError) =>
      KanbanStorageFailed.make({
        operation,
        reason: KanbanStorageReason.cases.Storage.make({}),
        cause,
      });
  const unencoded = (operation: KanbanStorageFailed["operation"]) => (cause: Schema.SchemaError) =>
    KanbanStorageFailed.make({
      operation,
      reason: KanbanStorageReason.cases.Encode.make({}),
      cause,
    });
  const rows =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
      Effect.flatMap(query, Schema.decodeUnknownEffect(Schema.Array(schema)));

  const goals = (where: "active" | "one", goalInstanceId = "") =>
    (where === "active"
      ? sql`SELECT * FROM kanban_goals WHERE status = 'active' ORDER BY created_at`
      : sql`SELECT * FROM kanban_goals WHERE goal_instance_id = ${goalInstanceId}`
    ).pipe(
      rows(GoalRow),
      Effect.map((found) => found.map(toGoal)),
      Effect.mapError(failed("goal")),
    );

  const attempt = (key: CardAttemptKey) =>
    sql`SELECT * FROM kanban_card_attempts WHERE goal_instance_id = ${key.goalInstanceId}
        AND card_id = ${key.cardId} AND attempt_no = ${key.attemptNo}`.pipe(
      rows(AttemptRow),
      Effect.map((found) => Option.map(Option.fromUndefinedOr(found[0]), toAttempt)),
      Effect.mapError(failed("attempt")),
    );

  const ladder = (goalInstanceId: string, cardId: string) =>
    sql`SELECT failure_streak, replans, generation, not_before, reason, resolution_of, notes_json
        FROM kanban_cards WHERE goal_instance_id = ${goalInstanceId} AND card_id = ${cardId}`.pipe(
      rows(CardRow),
      Effect.map((found) =>
        Option.match(Option.fromUndefinedOr(found[0]), {
          onNone: () => freshLadder,
          onSome: (row): CardLadder => ({
            failureStreak: row.failure_streak,
            replans: row.replans,
            generation: row.generation,
            notBefore: row.not_before,
            reason: row.reason,
            resolutionOf: row.resolution_of,
            notes: row.notes_json,
          }),
        }),
      ),
      Effect.mapError(failed("card")),
    );

  return {
    /** Every Goal instance whose board is running, oldest first. */
    activeGoals: goals("active"),

    goal: (goalInstanceId: string) =>
      Effect.map(goals("one", goalInstanceId), (found) => Option.fromUndefinedOr(found[0])),

    /** Starts (or restarts) running a Goal instance as a board; an existing row keeps its state. */
    registerGoal: Effect.fn("CardAttempts.registerGoal")(function* (
      goal: Omit<KanbanGoal, "hold" | "active">,
    ) {
      const at = yield* now;
      yield* sql`INSERT INTO kanban_goals
          (goal_instance_id, session_id, project_id, project_root, mode, goal_version, hold_json,
           status, created_at, updated_at)
          VALUES (${goal.goalInstanceId}, ${goal.sessionId}, ${goal.projectId}, ${goal.projectRoot},
            ${goal.mode}, ${goal.goalVersion}, NULL, 'active', ${at}, ${at})
          ON CONFLICT(goal_instance_id) DO UPDATE SET status = 'active', updated_at = ${at}`.pipe(
        Effect.mapError(failed("goal")),
      );
    }),

    stopGoal: (goalInstanceId: string) =>
      Effect.flatMap(now, (at) =>
        sql`UPDATE kanban_goals SET status = 'stopped', updated_at = ${at}
            WHERE goal_instance_id = ${goalInstanceId}`.pipe(Effect.mapError(failed("goal"))),
      ),

    /** Holds or releases new assignments, and records the Goal version cards now follow. */
    setHold: Effect.fn("CardAttempts.setHold")(function* (
      goalInstanceId: string,
      hold: AssignmentHold | null,
      goalVersion: number,
    ) {
      const at = yield* now;
      const json =
        hold === null ? null : yield* encodeHold(hold).pipe(Effect.mapError(unencoded("goal")));
      yield* sql`UPDATE kanban_goals SET hold_json = ${json}, goal_version = ${goalVersion},
            updated_at = ${at} WHERE goal_instance_id = ${goalInstanceId}`.pipe(
        Effect.mapError(failed("goal")),
      );
    }),

    /** The next attempt number of a card, from what is stored. */
    nextAttemptNo: (goalInstanceId: string, cardId: string) =>
      sql`SELECT MAX(attempt_no) AS value FROM kanban_card_attempts
          WHERE goal_instance_id = ${goalInstanceId} AND card_id = ${cardId}`.pipe(
        rows(NumberRow),
        Effect.map((found) => (found[0]?.value ?? 0) + 1),
        Effect.mapError(failed("attempt")),
      ),

    /** Stores an attempt before its queue item is offered; offering the same key again is a no-op. */
    open: Effect.fn("CardAttempts.open")(function* (
      attempt: Omit<CardAttempt, "outcome" | "handled">,
    ) {
      const at = yield* now;
      yield* sql`INSERT OR IGNORE INTO kanban_card_attempts
          (goal_instance_id, card_id, attempt_no, session_id, goal_version, plan_version,
           outcome_json, handled, created_at, updated_at)
          VALUES (${attempt.goalInstanceId}, ${attempt.cardId}, ${attempt.attemptNo},
            ${attempt.sessionId}, ${attempt.goalVersion}, ${attempt.planVersion}, NULL, 0,
            ${at}, ${at})`.pipe(Effect.mapError(failed("attempt")));
    }),

    attempt,

    /** Waits until an attempt's outcome is recorded by this process, or returns the stored one. */
    awaitOutcome: (key: CardAttemptKey) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before looking, so a record made between the look and the wait is seen.
          const wakeups = yield* PubSub.subscribe(recorded);
          // The next outcome this process records for the Goal instance, of any of its cards.
          const nextRecord = PubSub.take(wakeups).pipe(
            Effect.repeat({ until: (woke) => woke === key.goalInstanceId }),
          );
          const outcome: Effect.Effect<CardAttemptOutcome, KanbanStorageFailed> = Effect.flatMap(
            attempt(key),
            (current) =>
              Option.match(
                Option.flatMapNullishOr(current, (found) => found.outcome),
                {
                  onSome: Effect.succeed,
                  onNone: () => Effect.andThen(nextRecord, outcome),
                },
              ),
          );
          return yield* outcome;
        }),
      ),

    /** Signals each time an outcome of the Goal instance is recorded in this process. */
    recordedOutcomes: (goalInstanceId: string) =>
      Stream.fromPubSub(recorded).pipe(
        Stream.filter((goal) => goal === goalInstanceId),
        Stream.map(() => undefined),
      ),

    /** Attempts the orchestrator has not taken up yet: running ones and finished ones. */
    pending: (goalInstanceId: string) =>
      sql`SELECT * FROM kanban_card_attempts WHERE goal_instance_id = ${goalInstanceId}
          AND handled = 0 ORDER BY created_at, card_id`.pipe(
        rows(AttemptRow),
        Effect.map((found) => found.map(toAttempt)),
        Effect.mapError(failed("attempt")),
      ),

    /** Offered attempts without a recorded outcome, per active Goal: the slots each one holds. */
    outstanding: sql`SELECT a.goal_instance_id, COUNT(*) AS value FROM kanban_card_attempts a
        JOIN kanban_goals g ON g.goal_instance_id = a.goal_instance_id
        WHERE g.status = 'active' AND a.outcome_json IS NULL
        GROUP BY a.goal_instance_id`.pipe(
      rows(Schema.Struct({ goal_instance_id: Schema.String, value: Schema.Int })),
      Effect.map(
        (found): ReadonlyMap<string, number> =>
          new Map(found.map((row) => [row.goal_instance_id, row.value])),
      ),
      Effect.mapError(failed("attempt")),
    ),

    /** The handler's record of how an attempt ended. The first record stays. */
    recordOutcome: Effect.fn("CardAttempts.recordOutcome")(function* (
      key: CardAttemptKey,
      outcome: CardAttemptOutcome,
    ) {
      const at = yield* now;
      const json = yield* encodeOutcome(outcome).pipe(Effect.mapError(unencoded("attempt")));
      yield* sql`UPDATE kanban_card_attempts SET outcome_json = ${json}, updated_at = ${at}
          WHERE goal_instance_id = ${key.goalInstanceId} AND card_id = ${key.cardId}
            AND attempt_no = ${key.attemptNo} AND outcome_json IS NULL`.pipe(
        Effect.mapError(failed("attempt")),
      );
      yield* PubSub.publish(recorded, key.goalInstanceId);
    }),

    markHandled: (key: CardAttemptKey) =>
      Effect.flatMap(now, (at) =>
        sql`UPDATE kanban_card_attempts SET handled = 1, updated_at = ${at}
            WHERE goal_instance_id = ${key.goalInstanceId} AND card_id = ${key.cardId}
              AND attempt_no = ${key.attemptNo}`.pipe(Effect.mapError(failed("attempt"))),
      ),

    /** Names an agent run a delivery started, before the agent can do anything. */
    registerRun: Effect.fn("CardAttempts.registerRun")(function* (
      key: CardAttemptKey,
      run: { readonly runId: string; readonly traceAttemptId: string | null },
    ) {
      const at = yield* now;
      yield* sql`INSERT OR IGNORE INTO kanban_card_runs
          (run_id, goal_instance_id, card_id, attempt_no, trace_attempt_id, acknowledged_at, created_at)
          VALUES (${run.runId}, ${key.goalInstanceId}, ${key.cardId}, ${key.attemptNo},
            ${run.traceAttemptId}, NULL, ${at})`.pipe(Effect.mapError(failed("run")));
    }),

    /** Whether the card ran before, so a new attempt continues instead of starting over. */
    hasRuns: (goalInstanceId: string, cardId: string) =>
      sql`SELECT COUNT(*) AS value FROM kanban_card_runs
          WHERE goal_instance_id = ${goalInstanceId} AND card_id = ${cardId}`.pipe(
        rows(NumberRow),
        Effect.map((found) => (found[0]?.value ?? 0) > 0),
        Effect.mapError(failed("run")),
      ),

    /**
     * A run of the card a new attempt must not continue past: it did not complete, and it may have
     * left a pending or uncertain tool, or a write tool without a recorded result
     * (`endedWithKnownEffectsSql`), or its Work Trace attempt requested a tool call that never settled.
     * A run with no `chat_runs` row never reached the model. Acknowledged runs no longer fence.
     */
    fencedRun: (goalInstanceId: string, cardId: string) =>
      sql`SELECT k.run_id FROM kanban_card_runs k JOIN chat_runs r ON r.run_id = k.run_id
          WHERE k.goal_instance_id = ${goalInstanceId} AND k.card_id = ${cardId}
            AND k.acknowledged_at IS NULL AND r.status <> 'completed'
            AND (NOT ${sql.literal(endedWithKnownEffectsSql("r"))}
              OR EXISTS (SELECT 1 FROM agent_run_attempts a
                WHERE a.id = k.trace_attempt_id AND a.pending_tool_call_ids <> '[]'))
          ORDER BY k.created_at LIMIT 1`.pipe(
        rows(RunRow),
        Effect.map((found) => Option.map(Option.fromUndefinedOr(found[0]), (row) => row.run_id)),
        Effect.mapError(failed("run")),
      ),

    /** Answered decisions of the Goal instance whose follow-up the loop already did. */
    followedDecisions: (goalInstanceId: string) =>
      sql`SELECT request_id FROM kanban_decision_followups
          WHERE goal_instance_id = ${goalInstanceId}`.pipe(
        rows(RequestRow),
        Effect.map((found) => new Set(found.map((row) => row.request_id))),
        Effect.mapError(failed("decision")),
      ),

    /** Records that the loop did an answered decision's follow-up. */
    markDecisionFollowed: Effect.fn("CardAttempts.markDecisionFollowed")(function* (request: {
      readonly requestId: string;
      readonly goalInstanceId: string;
      readonly cardId: string;
    }) {
      const at = yield* now;
      yield* sql`INSERT OR IGNORE INTO kanban_decision_followups
          (request_id, goal_instance_id, card_id, created_at)
          VALUES (${request.requestId}, ${request.goalInstanceId}, ${request.cardId}, ${at})`.pipe(
        Effect.mapError(failed("decision")),
      );
    }),

    /** A person decided past a fenced run; later attempts may continue the card. */
    acknowledgeRun: (runId: string) =>
      Effect.flatMap(now, (at) =>
        sql`UPDATE kanban_card_runs SET acknowledged_at = ${at}
            WHERE run_id = ${runId} AND acknowledged_at IS NULL`.pipe(
          Effect.mapError(failed("run")),
        ),
      ),

    ladder,

    /** Saves a card's ladder position from the stored one. */
    updateLadder: Effect.fn("CardAttempts.updateLadder")(function* (
      goalInstanceId: string,
      cardId: string,
      change: (current: CardLadder) => CardLadder,
    ) {
      const next = change(yield* ladder(goalInstanceId, cardId));
      const notes = yield* encodeNotes(next.notes).pipe(Effect.mapError(unencoded("card")));
      const reason = yield* encodeReason(next.reason).pipe(Effect.mapError(unencoded("card")));
      yield* sql`INSERT INTO kanban_cards
          (goal_instance_id, card_id, failure_streak, replans, generation, not_before, reason,
           resolution_of, notes_json)
          VALUES (${goalInstanceId}, ${cardId}, ${next.failureStreak}, ${next.replans},
            ${next.generation}, ${next.notBefore}, ${reason}, ${next.resolutionOf}, ${notes})
          ON CONFLICT(goal_instance_id, card_id) DO UPDATE SET
            failure_streak = excluded.failure_streak, replans = excluded.replans,
            generation = excluded.generation, not_before = excluded.not_before,
            reason = excluded.reason, resolution_of = excluded.resolution_of,
            notes_json = excluded.notes_json`.pipe(Effect.mapError(failed("card")));
      return next;
    }),

    /** Hands a requeued attempt back to the orchestrator once its new outcome is recorded. */
    reopen: Effect.fn("CardAttempts.reopen")(function* (key: CardAttemptKey) {
      const at = yield* now;
      yield* sql`UPDATE kanban_card_attempts SET handled = 0, outcome_json = NULL, updated_at = ${at}
          WHERE goal_instance_id = ${key.goalInstanceId} AND card_id = ${key.cardId}
            AND attempt_no = ${key.attemptNo}`.pipe(Effect.mapError(failed("attempt")));
    }),

    /** How many user changes to executing cards wait for the orchestrator in a session. */
    pendingChangeRequests: (sessionId: string) =>
      sql`SELECT COUNT(*) AS value FROM board_change_requests
          WHERE session_id = ${sessionId} AND status = 'pending'`.pipe(
        rows(NumberRow),
        Effect.map((found) => found[0]?.value ?? 0),
        Effect.mapError(failed("change_request")),
      ),

    /** A user's pending change to an executing card, by id within its session. */
    changeRequest: (sessionId: string, requestId: number) =>
      sql`SELECT id, card_id, change_json, status FROM board_change_requests
          WHERE session_id = ${sessionId} AND id = ${requestId}`.pipe(
        rows(ChangeRequestRow),
        Effect.map((found) => Option.fromUndefinedOr(found[0])),
        Effect.mapError(failed("change_request")),
      ),

    /** Settles a pending change request; one already settled stays as it was. */
    settleChangeRequest: Effect.fn("CardAttempts.settleChangeRequest")(function* (
      requestId: number,
      settlement: {
        readonly status: "applied" | "reassigned" | "rejected";
        readonly reason: string | null;
      },
    ) {
      const at = DateTime.formatIso(yield* DateTime.now);
      const settled = yield* sql`UPDATE board_change_requests
          SET status = ${settlement.status}, reason = ${settlement.reason}, resolved_at = ${at}
          WHERE id = ${requestId} AND status = 'pending' RETURNING id`.pipe(
        Effect.mapError(failed("change_request")),
      );
      return settled.length > 0;
    }),

    /** Dead-lettered items of a queue, named by the attempt their payload carries. */
    deadLettered: (queueName: string) =>
      sql`SELECT id,
            json_extract(element_json, '$.payload.goalInstanceId') AS goal_instance_id,
            json_extract(element_json, '$.payload.cardId') AS card_id,
            json_extract(element_json, '$.payload.attemptNo') AS attempt_no
          FROM persisted_queue_items WHERE queue_name = ${queueName} AND state = 'failed'
          ORDER BY updated_at, sequence`.pipe(
        rows(DeadRow),
        Effect.map((found) =>
          found.flatMap((row): DeadLetteredAttempt[] =>
            row.goal_instance_id === null || row.card_id === null || row.attempt_no === null
              ? []
              : [
                  {
                    itemId: row.id,
                    goalInstanceId: row.goal_instance_id,
                    cardId: row.card_id,
                    attemptNo: row.attempt_no,
                  },
                ],
          ),
        ),
        Effect.mapError(failed("dead_letters")),
      ),
  };
});

/** Kanban execution records. Owner process only. */
export class CardAttempts extends Context.Service<CardAttempts, Effect.Success<typeof make>>()(
  "memory-agent/kanban/card-attempts/CardAttempts",
) {
  static readonly layer = Layer.effect(CardAttempts, make);
}
