import {
  Array as Arr,
  Clock,
  Context,
  DateTime,
  Effect,
  HashSet,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { NodeCrypto } from "@effect/platform-node";
import { BackgroundTaskEnd } from "../tools/background-end.ts";
import { TaskStatusChange } from "../work-trace/task-status.ts";
import { MessageDelivery } from "./message-delivery.ts";

/**
 * What the app's orchestrator hands a conversation's model without the user typing it: the end of a
 * task, a message another conversation left, the board's call. One table for every sender
 * (docs/decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다"). A row waits until
 * the model answers the message that tells it; the app restarts never lose one. The user's own
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
 * that moves to the table adds its key. `task` carries the end of a background task or the status
 * change of a Work Trace task; the payload's tag says which.
 */
export const notificationPayloads = {
  conversation: ConversationMessage,
  task: Schema.Union([BackgroundTaskEnd, TaskStatusChange]),
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

const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)),
);

/** The statement that stores a row unless a row with its id is there already; that row stays as it is. */
const insertOnceWith = (sql: SqlClient.SqlClient) =>
  SqlSchema.void({
    Request: NotificationRow,
    execute: (row) => sql`
      INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
        delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.session_id}, ${row.sender}, ${row.delivery}, ${row.payload},
        ${row.state}, ${row.delivered_run_id}, ${row.created_at}, ${row.delivered_at})
      ON CONFLICT(id) DO NOTHING`,
  });

/**
 * The writes the Work Trace store makes for its tasks' status changes, with its own connection, so
 * a change and its notification are stored in one transaction. They fail as the connection fails.
 */
export const taskStatusWrites = (sql: SqlClient.SqlClient) => {
  const insertOnce = insertOnceWith(sql);
  return {
    /**
     * Stores one waiting status change under `id` unless a row with that id is there already: that
     * row stays as it is, waiting or delivered.
     */
    putOnce: (entry: {
      readonly id: string;
      readonly sessionId: string;
      readonly delivery: MessageDelivery;
      readonly payload: TaskStatusChange;
    }) =>
      Effect.flatMap(isoNow, (now) =>
        insertOnce({
          id: entry.id,
          session_id: entry.sessionId,
          sender: "task",
          delivery: entry.delivery,
          payload: entry.payload,
          state: "waiting",
          delivered_run_id: null,
          created_at: now,
          delivered_at: null,
        }),
      ),
    /**
     * Takes the words out of a deleted task's status changes: their summary and detail. The rows
     * stay, so a change the model was not told yet is still told.
     */
    redact: SqlSchema.void({
      Request: Schema.String,
      execute: (taskId) => sql`
        UPDATE orchestrator_notifications
        SET payload = json_set(payload, '$.summary', 'Deleted task lifecycle notification',
          '$.detail', json('{}'))
        WHERE sender = 'task' AND json_extract(payload, '$._tag') = 'TaskStatus'
          AND json_extract(payload, '$.taskId') = ${taskId}`,
    }),
  };
};

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
  const insertOnce = insertOnceWith(sql);
  /** The rows of a conversation that wait, oldest first. */
  const waiting = SqlSchema.findAll({
    Request: Schema.String,
    Result: NotificationRow,
    execute: (sessionId) => sql`
      SELECT * FROM orchestrator_notifications
      WHERE session_id = ${sessionId} AND state = 'waiting'
      ORDER BY created_at, id`,
  });
  /** The rows of one sender that wait in a conversation, oldest first. */
  const waitingFrom = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, sender: NotificationSender }),
    Result: NotificationRow,
    execute: ({ sessionId, sender }) => sql`
      SELECT * FROM orchestrator_notifications
      WHERE session_id = ${sessionId} AND sender = ${sender} AND state = 'waiting'
      ORDER BY created_at, id`,
  });
  /** A waiting row that wakes its conversation, unless the user stopped its notifications. */
  const wakingRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ waking: Schema.Finite }),
    execute: (sessionId) => sql`
      SELECT 1 AS waking FROM orchestrator_notifications n
      WHERE n.session_id = ${sessionId} AND n.state = 'waiting'
        AND n.delivery = 'wake'
        AND NOT EXISTS (
          SELECT 1 FROM parent_notification_holds h WHERE h.session_id = n.session_id
        )
      LIMIT 1`,
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
        delivered_at = ${deliveredAt}
      WHERE session_id = ${sessionId} AND state = 'waiting' AND id IN ${sql.in(ids)}
      RETURNING id`,
  });
  /** Whether the user stopped the session's notifications (decisions.md "대상 세션의 다음 run에 전달한다"). */
  const notificationsHeld = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ held: Schema.Finite }),
    execute: (sessionId) => sql`
      SELECT 1 AS held FROM parent_notification_holds WHERE session_id = ${sessionId}`,
  });

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

    /** The rows of a conversation that still wait, oldest first: those the model has not answered. */
    pending: (sessionId: string) =>
      Effect.map(waiting(sessionId), (rows) => rows.map(toEntry)).pipe(stored),

    /**
     * Whether the conversation has a waiting row that wakes it (`wake` delivery), whoever sent it.
     * It stays true until the model answers the row. A conversation whose user stopped the
     * notifications is not woken.
     */
    wakes: (sessionId: string) => Effect.map(wakingRow(sessionId), Option.isSome).pipe(stored),

    /**
     * The conversation's waiting rows of the sender `sender` that its conversation does not tell
     * yet, oldest first; the rows of other senders stay for the hook that tells them. `told` holds
     * the ids the conversation's messages tell (`toldIn`, agent/orchestrator-message.ts). Nothing
     * is written: a row is told by the message that carries its id being saved in the
     * conversation, so a run that never saves that message leaves the row for the next run. A
     * session whose user stopped the notifications (parent_notification_holds, decisions.md "대상
     * 세션의 다음 run에 전달한다") is given nothing: its rows keep waiting for a later run.
     */
    untold: <Sender extends StoredSender>(
      sessionId: string,
      sender: Sender,
      told: HashSet.HashSet<string>,
    ) =>
      Effect.gen(function* () {
        const held = yield* notificationsHeld(sessionId);
        if (Option.isSome(held)) return [];
        const rows = yield* waitingFrom({ sessionId, sender });
        // The rows read are this sender's already; the guard gives them that sender's type.
        const fromSender = (
          entry: NotificationEntry,
        ): entry is Extract<NotificationEntry, { readonly sender: Sender }> =>
          entry.sender === sender;
        return Arr.filterMap(rows, (row) => {
          const entry = toEntry(row);
          return !HashSet.has(told, row.id) && fromSender(entry)
            ? Result.succeed(entry)
            : Result.failVoid;
        });
      }).pipe(stored),

    /**
     * Marks delivered by the run `runId` the conversation's waiting rows the run delivered,
     * whoever sent them: `delivered` holds their ids, read from the run's saved conversation
     * (`heardBy`, agent/orchestrator-message.ts). A row already delivered stays as it is. Returns
     * the ids it marked.
     */
    heard: (sessionId: string, runId: string, delivered: HashSet.HashSet<string>) =>
      Effect.gen(function* () {
        if (HashSet.size(delivered) === 0) return [];
        const ids = (yield* waiting(sessionId)).flatMap((row) =>
          HashSet.has(delivered, row.id) ? [row.id] : [],
        );
        if (ids.length === 0) return [];
        const marked = yield* markDeliveredRows({
          sessionId,
          ids,
          deliveredRunId: runId,
          deliveredAt: yield* isoNow,
        });
        return marked.map((row) => row.id);
      }).pipe(sql.withTransaction, stored),

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
