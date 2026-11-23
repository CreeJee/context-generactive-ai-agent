import {
  Array as Arr,
  Clock,
  Context,
  DateTime,
  Effect,
  HashSet,
  Iterable,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { NodeCrypto } from "@effect/platform-node";
import { BackgroundTaskEnd } from "../tools/background-end.ts";
import { MessageDelivery } from "./message-delivery.ts";

/**
 * What the app's orchestrator hands a conversation's model without the user typing it: the end of a
 * task, a message another conversation left, the board's call. One table for every sender
 * (docs/decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다"). A row waits until
 * a run of its conversation hands it to the model; the app restarts never lose one. The user's own
 * waiting messages are not here: they stay in `queued_messages`.
 */

/** Who sent the message. */
export const NotificationSender = Schema.Literals(["task", "conversation", "board"]);
export type NotificationSender = typeof NotificationSender.Type;

export const NotificationState = Schema.Literals(["waiting", "delivered"]);
export type NotificationState = typeof NotificationState.Type;

/** What another conversation of the same project left for this one. */
export const ConversationMessage = Schema.Struct({
  projectId: Schema.String,
  fromSessionId: Schema.String,
  fromRunId: Schema.String,
  body: Schema.String,
});
export type ConversationMessage = typeof ConversationMessage.Type;

/**
 * What each sender's message carries. Only the senders listed here are stored and read; a sender
 * that moves to the table adds its key. `task` carries the end of a background task; its payload
 * is tagged because the ends of other kinds of task join the same sender later.
 */
export const notificationPayloads = {
  conversation: ConversationMessage,
  task: BackgroundTaskEnd,
} as const;
type StoredSender = keyof typeof notificationPayloads;
type PayloadOf<Sender extends StoredSender> = (typeof notificationPayloads)[Sender]["Type"];

/** One message to put in a conversation's notifications. */
export type NewNotificationEntry = {
  readonly [Sender in StoredSender]: {
    readonly sessionId: string;
    readonly sender: Sender;
    readonly delivery: MessageDelivery;
    readonly payload: PayloadOf<Sender>;
  };
}[StoredSender];

/** One notifications row as a run or a test reads it. `sender` tells which payload it carries. */
export type NotificationEntry = {
  readonly [Sender in StoredSender]: {
    readonly id: string;
    readonly sessionId: string;
    readonly sender: Sender;
    readonly delivery: MessageDelivery;
    readonly payload: PayloadOf<Sender>;
    readonly state: NotificationState;
    readonly deliveredRunId: string | null;
    readonly createdAt: string;
    readonly deliveredAt: string | null;
  };
}[StoredSender];

export class NotificationStoreFailed extends Schema.TaggedError<
  NotificationStoreFailed,
  { readonly brand: unique symbol }
>()("NotificationStoreFailed", { cause: Schema.Defect() }) {}
/** Reads the store's own table through the owner's connection as `NotificationStoreFailed`. */
const stored = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, NotificationStoreFailed, R> =>
  Effect.mapError(effect, (cause) => NotificationStoreFailed.make({ cause }));

const rowOf = <Sender extends StoredSender>(sender: Sender) =>
  Schema.Struct({
    id: Schema.String,
    session_id: Schema.String,
    sender: Schema.Literal(sender),
    delivery: MessageDelivery,
    payload: Schema.fromJsonString(notificationPayloads[sender]),
    state: NotificationState,
    delivered_run_id: Schema.NullOr(Schema.String),
    created_at: Schema.String,
    delivered_at: Schema.NullOr(Schema.String),
  });
const NotificationRow = Schema.Union([rowOf("conversation"), rowOf("task")]);
type NotificationRow = typeof NotificationRow.Type;

const toEntry = ({
  session_id,
  delivered_run_id,
  created_at,
  delivered_at,
  ...sent
}: NotificationRow): NotificationEntry => ({
  ...sent,
  sessionId: session_id,
  deliveredRunId: delivered_run_id,
  createdAt: created_at,
  deliveredAt: delivered_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const insert = SqlSchema.findOne({
    Request: NotificationRow,
    Result: NotificationRow,
    execute: (row) => sql`
      INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
        delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.session_id}, ${row.sender}, ${row.delivery}, ${row.payload},
        ${row.state}, ${row.delivered_run_id}, ${row.created_at}, ${row.delivered_at})
      RETURNING *`,
  });
  /** Stores the row unless a row with its id is there already; that row stays as it is. */
  const insertOnce = SqlSchema.void({
    Request: NotificationRow,
    execute: (row) => sql`
      INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
        delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.session_id}, ${row.sender}, ${row.delivery}, ${row.payload},
        ${row.state}, ${row.delivered_run_id}, ${row.created_at}, ${row.delivered_at})
      ON CONFLICT(id) DO NOTHING`,
  });
  /** The rows of a conversation that wait and that no run holds, oldest first. */
  const waiting = SqlSchema.findAll({
    Request: Schema.String,
    Result: NotificationRow,
    execute: (sessionId) => sql`
      SELECT * FROM orchestrator_notifications
      WHERE session_id = ${sessionId} AND state = 'waiting' AND claimed_run_id IS NULL
      ORDER BY created_at, id`,
  });
  /** The rows of one sender that wait in a conversation and that no run holds, oldest first. */
  const waitingFrom = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, sender: NotificationSender }),
    Result: NotificationRow,
    execute: ({ sessionId, sender }) => sql`
      SELECT * FROM orchestrator_notifications
      WHERE session_id = ${sessionId} AND sender = ${sender} AND state = 'waiting'
        AND claimed_run_id IS NULL
      ORDER BY created_at, id`,
  });
  /** A waiting row no run holds that wakes its conversation, unless the user stopped its notifications. */
  const wakingRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ waking: Schema.Finite }),
    execute: (sessionId) => sql`
      SELECT 1 AS waking FROM orchestrator_notifications n
      WHERE n.session_id = ${sessionId} AND n.state = 'waiting' AND n.claimed_run_id IS NULL
        AND n.delivery = 'wake'
        AND NOT EXISTS (
          SELECT 1 FROM parent_notification_holds h WHERE h.session_id = n.session_id
        )
      LIMIT 1`,
  });
  /** One run's claim on waiting rows: the mark that says which run is delivering them. */
  const claimRows = SqlSchema.findAll({
    Request: Schema.Struct({
      sessionId: Schema.String,
      ids: Schema.Array(Schema.String),
      runId: Schema.String,
      now: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ sessionId, ids, runId, now }) => sql`
      UPDATE orchestrator_notifications SET claimed_run_id = ${runId}, claimed_at = ${now}
      WHERE session_id = ${sessionId} AND state = 'waiting' AND claimed_run_id IS NULL
        AND id IN ${sql.in(ids)}
      RETURNING id`,
  });
  const dropClaims = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, runId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ sessionId, runId }) => sql`
      UPDATE orchestrator_notifications SET claimed_run_id = NULL, claimed_at = NULL
      WHERE session_id = ${sessionId} AND claimed_run_id = ${runId}
      RETURNING id`,
  });
  const markDeliveredRows = SqlSchema.findAll({
    Request: Schema.Struct({
      sessionId: Schema.String,
      ids: Schema.Array(Schema.String),
      deliveredRunId: Schema.String,
      deliveredAt: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ sessionId, ids, deliveredRunId, deliveredAt }) => sql`
      UPDATE orchestrator_notifications
      SET state = 'delivered', delivered_run_id = ${deliveredRunId},
        delivered_at = ${deliveredAt}, claimed_run_id = NULL, claimed_at = NULL
      WHERE session_id = ${sessionId} AND state = 'waiting' AND id IN ${sql.in(ids)}
      RETURNING id`,
  });
  const markClaimedDelivered = SqlSchema.findAll({
    Request: Schema.Struct({
      sessionId: Schema.String,
      runId: Schema.String,
      deliveredAt: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ sessionId, runId, deliveredAt }) => sql`
      UPDATE orchestrator_notifications SET state = 'delivered', delivered_run_id = ${runId},
        delivered_at = ${deliveredAt}, claimed_run_id = NULL, claimed_at = NULL
      WHERE session_id = ${sessionId} AND state = 'waiting' AND claimed_run_id = ${runId}
      RETURNING id`,
  });
  const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  /** Whether the user stopped the session's notifications (decisions.md "대상 세션의 다음 run에 전달한다"). */
  const notificationsHeld = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ held: Schema.Finite }),
    execute: (sessionId) => sql`
      SELECT 1 AS held FROM parent_notification_holds WHERE session_id = ${sessionId}`,
  });

  // A run that claimed rows and then died without settling them leaves its claims behind. A claim
  // of a run that finished delivered what it claimed; every other claim is dropped, so those rows
  // wait for the next run again. No current-process runs exist while this singleton is
  // constructed, as the work trace's startup recovery assumes.
  const settleAbandonedClaims = Effect.gen(function* () {
    const now = yield* isoNow;
    yield* Effect.asVoid(sql`
      UPDATE orchestrator_notifications
      SET state = 'delivered', delivered_run_id = claimed_run_id,
        delivered_at = ${now}, claimed_run_id = NULL, claimed_at = NULL
      WHERE state = 'waiting' AND claimed_run_id IN (
        SELECT run_id FROM chat_runs WHERE status IN ('completed', 'interrupted'))`);
    yield* Effect.asVoid(sql`
      UPDATE orchestrator_notifications SET claimed_run_id = NULL, claimed_at = NULL
      WHERE claimed_run_id IS NOT NULL`);
  });

  yield* settleAbandonedClaims;

  return {
    /** Stores one waiting message for the conversation and returns the row it stored. */
    put: ({ sessionId, ...sent }: NewNotificationEntry) =>
      Effect.gen(function* () {
        const id = yield* crypto.uuidV7();
        const row = yield* insert({
          ...sent,
          id,
          session_id: sessionId,
          state: "waiting",
          delivered_run_id: null,
          created_at: yield* isoNow,
          delivered_at: null,
        });
        return toEntry(row);
      }).pipe(stored),

    /**
     * Stores one waiting message under the id its sender gives it, unless a row with that id is
     * there already: that row stays as it is, waiting or delivered. A sender that keeps its own
     * record of what it tells calls this with the record's id, so one record has one row however
     * often it is put.
     */
    putOnce: ({ sessionId, ...sent }: NewNotificationEntry & { readonly id: string }) =>
      Effect.gen(function* () {
        yield* insertOnce({
          ...sent,
          session_id: sessionId,
          state: "waiting",
          delivered_run_id: null,
          created_at: yield* isoNow,
          delivered_at: null,
        });
      }).pipe(stored),

    /** The rows of a conversation that still wait and that no run holds, oldest first. */
    pending: (sessionId: string) =>
      Effect.map(waiting(sessionId), (rows) => rows.map(toEntry)).pipe(stored),

    /**
     * Whether the conversation has a waiting row no run holds that wakes it (`wake` delivery),
     * whoever sent it. A conversation whose user stopped the notifications is not woken.
     */
    wakes: (sessionId: string) => Effect.map(wakingRow(sessionId), Option.isSome).pipe(stored),

    /**
     * Takes the conversation's waiting rows of the sender `sender` for the run `runId`, oldest
     * first, each marked with the run that delivers it; the rows of other senders stay for the
     * hook that tells them. The mark keeps every run, including `runId` again, from taking the
     * same row twice; a run that does not finish gives its takes back with `release`, and a run
     * that finishes completes their delivery with `deliverClaimed`. A session whose user stopped
     * the notifications (parent_notification_holds, decisions.md "대상 세션의 다음 run에
     * 전달한다") takes nothing: its rows keep waiting for a later run.
     */
    claim: <Sender extends StoredSender>(sessionId: string, runId: string, sender: Sender) =>
      Effect.gen(function* () {
        const held = yield* notificationsHeld(sessionId);
        if (Option.isSome(held)) return [];
        const rows = yield* waitingFrom({ sessionId, sender });
        if (rows.length === 0) return [];
        const taken = yield* claimRows({
          sessionId,
          ids: rows.map((row) => row.id),
          runId,
          now: yield* isoNow,
        });
        const takenIds = HashSet.fromIterable(Iterable.map(taken, (row) => row.id));
        // The rows read are this sender's already; the guard gives them that sender's type.
        const fromSender = (
          entry: NotificationEntry,
        ): entry is Extract<NotificationEntry, { readonly sender: Sender }> =>
          entry.sender === sender;
        return Arr.filterMap(rows, (row) => {
          const entry = toEntry(row);
          return HashSet.has(takenIds, row.id) && fromSender(entry)
            ? Result.succeed(entry)
            : Result.failVoid;
        });
      }).pipe(sql.withTransaction, stored),

    /** Gives back the rows the run `runId` claimed; they wait for the next run again. */
    release: (sessionId: string, runId: string) =>
      Effect.asVoid(stored(dropClaims({ sessionId, runId }))),

    /**
     * Marks the rows the run `runId` claimed of the conversation delivered and lets go of the
     * claims. A row another call already delivered stays delivered. Returns the ids it marked.
     */
    deliverClaimed: (sessionId: string, runId: string) =>
      Effect.gen(function* () {
        const marked = yield* markClaimedDelivered({
          sessionId,
          runId,
          deliveredAt: yield* isoNow,
        });
        return marked.map((row) => row.id);
      }).pipe(stored),

    /**
     * Marks the listed waiting rows of the conversation delivered by the run `deliveredRunId`;
     * rows another call already delivered stay delivered. Returns the ids it actually marked.
     */
    deliver: (sessionId: string, deliveredRunId: string, ids: readonly string[]) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [];
        const marked = yield* markDeliveredRows({
          sessionId,
          ids: [...ids],
          deliveredRunId,
          deliveredAt: yield* isoNow,
        });
        return marked.map((row) => row.id);
      }).pipe(stored),
  };
});

/**
 * The persistent orchestrator notifications of every conversation. Reads and writes go through the
 * owner's own `SqlClient`, so a row written survives the process and the writer's scope.
 */
export class OrchestratorNotifications extends Context.Service<
  OrchestratorNotifications,
  Effect.Success<typeof make>
>()("memory-agent/sessions/orchestrator-notifications/OrchestratorNotifications") {
  static readonly layer = Layer.effect(OrchestratorNotifications, make).pipe(
    Layer.provide(NodeCrypto.layer),
  );
}
