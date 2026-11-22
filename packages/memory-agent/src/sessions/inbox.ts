import { Clock, Context, DateTime, Effect, HashSet, Iterable, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { NodeCrypto } from "@effect/platform-node";

/**
 * The messages that enter a conversation without the user typing them now, one table for every
 * sender (docs/decisions.md "대화에 들어오는 메시지는 세션 inbox 하나에 둔다"). A row waits until a
 * run of its conversation hands it to the model; the app restarts never lose one.
 */

/** Who sent the message. */
export const InboxSender = Schema.Literals(["user", "task", "conversation", "board"]);
export type InboxSender = typeof InboxSender.Type;

/**
 * When the message is handed to the conversation: `interrupt` cuts into the run in progress,
 * `wake` starts a run when the conversation is idle, `next_run` waits for a run that starts anyway.
 */
export const InboxDelivery = Schema.Literals(["interrupt", "wake", "next_run"]);
export type InboxDelivery = typeof InboxDelivery.Type;

export const InboxState = Schema.Literals(["waiting", "delivered"]);
export type InboxState = typeof InboxState.Type;

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
 * that moves to the inbox adds its key.
 */
export const inboxPayloads = {
  conversation: ConversationMessage,
} as const;
type StoredSender = keyof typeof inboxPayloads;
type PayloadOf<Sender extends StoredSender> = (typeof inboxPayloads)[Sender]["Type"];

/** One message to put in a conversation's inbox. */
export type NewInboxEntry = {
  readonly [Sender in StoredSender]: {
    readonly sessionId: string;
    readonly sender: Sender;
    readonly delivery: InboxDelivery;
    readonly payload: PayloadOf<Sender>;
  };
}[StoredSender];

/** One inbox row as a run or a test reads it. `sender` tells which payload it carries. */
export type InboxEntry = {
  readonly [Sender in StoredSender]: {
    readonly id: string;
    readonly sessionId: string;
    readonly sender: Sender;
    readonly delivery: InboxDelivery;
    readonly payload: PayloadOf<Sender>;
    readonly state: InboxState;
    readonly deliveredRunId: string | null;
    readonly createdAt: string;
    readonly deliveredAt: string | null;
  };
}[StoredSender];

export class InboxStoreFailed extends Schema.TaggedError<
  InboxStoreFailed,
  { readonly brand: unique symbol }
>()("InboxStoreFailed", { cause: Schema.Defect() }) {}
/** Reads the store's own table through the owner's connection as `InboxStoreFailed`. */
const stored = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, InboxStoreFailed, R> =>
  Effect.mapError(effect, (cause) => InboxStoreFailed.make({ cause }));

const rowOf = <Sender extends StoredSender>(sender: Sender) =>
  Schema.Struct({
    id: Schema.String,
    session_id: Schema.String,
    sender: Schema.Literal(sender),
    delivery: InboxDelivery,
    payload: Schema.fromJsonString(inboxPayloads[sender]),
    state: InboxState,
    delivered_run_id: Schema.NullOr(Schema.String),
    created_at: Schema.String,
    delivered_at: Schema.NullOr(Schema.String),
  });
const InboxRow = Schema.Union([rowOf("conversation")]);
type InboxRow = typeof InboxRow.Type;

const toEntry = ({
  session_id,
  delivered_run_id,
  created_at,
  delivered_at,
  ...sent
}: InboxRow): InboxEntry => ({
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
    Request: InboxRow,
    Result: InboxRow,
    execute: (row) => sql`
      INSERT INTO session_inbox (id, session_id, sender, delivery, payload, state,
        delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.session_id}, ${row.sender}, ${row.delivery}, ${row.payload},
        ${row.state}, ${row.delivered_run_id}, ${row.created_at}, ${row.delivered_at})
      RETURNING *`,
  });
  /** The rows of a conversation that wait and that no run holds, oldest first. */
  const waiting = SqlSchema.findAll({
    Request: Schema.String,
    Result: InboxRow,
    execute: (sessionId) => sql`
      SELECT * FROM session_inbox
      WHERE session_id = ${sessionId} AND state = 'waiting' AND claimed_run_id IS NULL
      ORDER BY created_at, id`,
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
      UPDATE session_inbox SET claimed_run_id = ${runId}, claimed_at = ${now}
      WHERE session_id = ${sessionId} AND state = 'waiting' AND claimed_run_id IS NULL
        AND id IN ${sql.in(ids)}
      RETURNING id`,
  });
  const dropClaims = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, runId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ sessionId, runId }) => sql`
      UPDATE session_inbox SET claimed_run_id = NULL, claimed_at = NULL
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
      UPDATE session_inbox SET state = 'delivered', delivered_run_id = ${deliveredRunId},
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
      UPDATE session_inbox SET state = 'delivered', delivered_run_id = ${runId},
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
      UPDATE session_inbox SET state = 'delivered', delivered_run_id = claimed_run_id,
        delivered_at = ${now}, claimed_run_id = NULL, claimed_at = NULL
      WHERE state = 'waiting' AND claimed_run_id IN (
        SELECT run_id FROM chat_runs WHERE status IN ('completed', 'interrupted'))`);
    yield* Effect.asVoid(sql`
      UPDATE session_inbox SET claimed_run_id = NULL, claimed_at = NULL
      WHERE claimed_run_id IS NOT NULL`);
  });

  yield* settleAbandonedClaims;

  return {
    /** Stores one waiting message for the conversation and returns the row it stored. */
    put: ({ sessionId, ...sent }: NewInboxEntry) =>
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

    /** The rows of a conversation that still wait and that no run holds, oldest first. */
    pending: (sessionId: string) =>
      Effect.map(waiting(sessionId), (rows) => rows.map(toEntry)).pipe(stored),

    /**
     * Takes the conversation's waiting rows for the run `runId`, oldest first, each marked with
     * the run that delivers it. The mark keeps every run, including `runId` again, from taking the
     * same row twice; a run that does not finish gives its takes back with `release`, and a run
     * that finishes completes their delivery with `deliverClaimed`. A session whose user stopped
     * the notifications (parent_notification_holds, decisions.md "대상 세션의 다음 run에
     * 전달한다") takes nothing: its rows keep waiting for a later run.
     */
    claim: (sessionId: string, runId: string) =>
      Effect.gen(function* () {
        const held = yield* notificationsHeld(sessionId);
        if (Option.isSome(held)) return [];
        const rows = yield* waiting(sessionId);
        if (rows.length === 0) return [];
        const taken = yield* claimRows({
          sessionId,
          ids: rows.map((row) => row.id),
          runId,
          now: yield* isoNow,
        });
        const takenIds = HashSet.fromIterable(Iterable.map(taken, (row) => row.id));
        return rows.filter((row) => HashSet.has(takenIds, row.id)).map(toEntry);
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
 * The persistent inbox of every conversation. Reads and writes go through the owner's own
 * `SqlClient`, so a row written survives the process and the writer's scope.
 */
export class SessionInbox extends Context.Service<SessionInbox, Effect.Success<typeof make>>()(
  "memory-agent/sessions/inbox/SessionInbox",
) {
  static readonly layer = Layer.effect(SessionInbox, make).pipe(Layer.provide(NodeCrypto.layer));
}
