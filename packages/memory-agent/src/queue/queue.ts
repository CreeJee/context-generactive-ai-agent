import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  Array as Arr,
  Clock,
  Context,
  Crypto,
  Effect,
  Layer,
  Match,
  MutableHashMap,
  Option,
  Schema,
} from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/sql";
import {
  type DeliveryVia,
  NextDelivery,
  QueueItemState,
  type QueuedMessage,
  type QueueSnapshot,
} from "./queue-state.ts";

const Row = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
  text: Schema.String,
  attachment_ids: Schema.fromJsonString(Schema.Array(Schema.String)),
  state: Schema.Literals(["waiting", "editing", "held", "delivered", "failed"]),
  draft: Schema.NullOr(Schema.String),
  delivered_via: Schema.NullOr(Schema.Literals(["tool_boundary", "steer", "next_turn"])),
  run_id: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  steered: Schema.Literals([0, 1]),
  created_at: Schema.Finite,
});

function toMessage(row: typeof Row.Type): QueuedMessage {
  const state = Match.value(row.state).pipe(
    Match.when("waiting", () => QueueItemState.waiting({ steered: row.steered === 1 })),
    Match.when("editing", () => QueueItemState.editing({ draft: row.draft ?? row.text })),
    Match.when("held", () => QueueItemState.held({ draft: row.draft })),
    // The table checks that a delivered row names how it was delivered.
    Match.when("delivered", () =>
      QueueItemState.delivered({ via: row.delivered_via ?? "next_turn", runId: row.run_id }),
    ),
    Match.when("failed", () => QueueItemState.failed({ reason: row.failure ?? "" })),
    Match.exhaustive,
  );
  return {
    id: row.id,
    seq: row.seq,
    text: row.text,
    attachmentIds: row.attachment_ids,
    state,
    createdAt: row.created_at,
  };
}

/** The message is gone, already delivered, or not in a state that allows the change. */
export class QueueChangeRefused extends Schema.TaggedError<QueueChangeRefused>()(
  "QueueChangeRefused",
  {
    id: Schema.String,
    reason: Schema.Literals(["not_found", "delivered", "not_held", "reserved"]),
  },
) {}

const SessionMessage = Schema.Struct({ sessionId: Schema.String, id: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const now = Clock.currentTimeMillis;
  // Reservations are checked and changed without a yield in between, so no two fibres claim one.
  const reservations = MutableHashMap.empty<
    string,
    { readonly id: string; readonly holdOnRelease: boolean }
  >();
  const findOne = SqlSchema.findOneOption({
    Request: SessionMessage,
    Result: Row,
    execute: ({ sessionId, id }) =>
      sql`SELECT * FROM queued_messages WHERE session_id = ${sessionId} AND id = ${id}`,
  });
  const get = (sessionId: string, id: string) =>
    findOne({ sessionId, id }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: toMessage })),
    );
  /** The message, if it may still change (not delivered). */
  const pending = Effect.fnUntraced(function* (sessionId: string, id: string) {
    const message = yield* findOne({ sessionId, id }).pipe(
      Effect.flatMap((row) =>
        Effect.fromOption(row, () => QueueChangeRefused.make({ id, reason: "not_found" })),
      ),
      Effect.map(toMessage),
    );
    yield* Effect.when(
      Effect.fail(QueueChangeRefused.make({ id, reason: "reserved" })),
      Effect.succeed(
        Option.exists(
          MutableHashMap.get(reservations, sessionId),
          (reserved) => reserved.id === id,
        ),
      ),
    );
    yield* Effect.when(
      Effect.fail(QueueChangeRefused.make({ id, reason: "delivered" })),
      Effect.succeed(QueueItemState.$is("delivered")(message.state)),
    );
    return message;
  });
  // Every change of state, editing included, takes a message off the steered path.
  const setState = (
    id: string,
    state: "waiting" | "editing" | "held" | "failed",
    fields: { text?: string; draft?: string | null; failure?: string | null } = {},
  ) =>
    Effect.flatMap(
      now,
      (at) => sql`
        UPDATE queued_messages SET state = ${state}, text = coalesce(${fields.text ?? null}, text),
          draft = ${fields.draft ?? null}, failure = ${fields.failure ?? null}, steered = 0,
          updated_at = ${at}
        WHERE id = ${id}`,
    );
  /** Checks the message and changes it in one transaction, then reads it back. */
  const change = <A, E>(
    sessionId: string,
    id: string,
    apply: (message: QueuedMessage) => Effect.Effect<A, E>,
  ) =>
    sql.withTransaction(
      pending(sessionId, id).pipe(Effect.flatMap(apply), Effect.andThen(get(sessionId, id))),
    );
  const list = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, recentRunId: Schema.NullOr(Schema.String) }),
    Result: Row,
    execute: ({ sessionId, recentRunId }) => sql`
      SELECT * FROM queued_messages
      WHERE session_id = ${sessionId} AND (state != 'delivered' OR run_id = ${recentRunId})
      ORDER BY seq`,
  });
  // The waiting prefix: waiting rows before the first message being edited or held.
  const deliverable = SqlSchema.findAll({
    Request: Schema.String,
    Result: Row,
    execute: (sessionId) => sql`
      SELECT * FROM queued_messages
      WHERE session_id = ${sessionId} AND state = 'waiting' AND seq < coalesce(
        (SELECT min(seq) FROM queued_messages
         WHERE session_id = ${sessionId} AND state IN ('editing', 'held')),
        9007199254740991)
      ORDER BY seq`,
  });
  // Only one row is needed for a next turn; do not materialize the whole waiting prefix.
  const head = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Row,
    execute: (sessionId) => sql`
      SELECT * FROM queued_messages
      WHERE session_id = ${sessionId} AND state IN ('waiting', 'editing', 'held')
      ORDER BY seq LIMIT 1`,
  });
  const insert = SqlSchema.findOne({
    Request: Schema.Struct({
      id: Schema.String,
      sessionId: Schema.String,
      text: Schema.String,
      attachmentIds: Schema.fromJsonString(Schema.Array(Schema.String)),
      steered: Schema.Literals([0, 1]),
      at: Schema.Finite,
    }),
    Result: Row,
    execute: (row) => sql`
      INSERT INTO queued_messages (id, session_id, seq, text, attachment_ids, state, steered, created_at, updated_at)
      VALUES (${row.id}, ${row.sessionId},
        (SELECT coalesce(max(seq), 0) + 1 FROM queued_messages WHERE session_id = ${row.sessionId}),
        ${row.text}, ${row.attachmentIds}, 'waiting', ${row.steered}, ${row.at}, ${row.at})
      RETURNING *`,
  });

  // A new process has no page editing and no run to deliver into: what was still on its way is
  // restored for the user to confirm, with any unsaved edit kept as a draft.
  yield* sql`
    UPDATE queued_messages SET state = 'held', steered = 0, updated_at = ${yield* now}
    WHERE state IN ('waiting', 'editing')`;

  const listMessages = (sessionId: string, recentRunId: string | null) =>
    Effect.map(list({ sessionId, recentRunId }), (rows) => rows.map(toMessage));

  return {
    /**
     * Messages still to deliver, plus those delivered by `recentRunId` so a page can show them as
     * delivered until its transcript catches up.
     */
    list: listMessages,

    /** Advisory snapshot; the delivery path always selects again from current queue state. */
    snapshot: (sessionId: string, recentRunId: string | null = null) =>
      Effect.map(listMessages(sessionId, recentRunId), (items): QueueSnapshot => {
        // Only the first nonterminal entry determines whether the page may request the next turn.
        // Batch selection for a tool boundary happens separately against the latest queue state.
        const first = Arr.findFirst(items, (item) =>
          QueueItemState.$match(item.state, {
            failed: () => Option.none(),
            delivered: () => Option.none(),
            waiting: ({ steered }) =>
              Option.some(steered ? NextDelivery.server() : NextDelivery.ready()),
            editing: () =>
              Option.some(NextDelivery.blocked({ messageId: item.id, reason: "editing" })),
            held: () => Option.some(NextDelivery.blocked({ messageId: item.id, reason: "held" })),
          }),
        );
        return { items, nextDelivery: Option.getOrElse(first, () => NextDelivery.empty()) };
      }),

    /**
     * Adds a message at the end. A steered one takes the waiting messages before it along, since
     * it cannot reach the model ahead of them.
     */
    add: (sessionId: string, text: string, attachmentIds: readonly string[], steered: boolean) =>
      Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4();
        const at = yield* now;
        yield* Effect.when(
          sql`
            UPDATE queued_messages SET steered = 1
            WHERE session_id = ${sessionId} AND state = 'waiting'`,
          Effect.succeed(steered),
        );
        const row = yield* insert({
          id,
          sessionId,
          text,
          attachmentIds,
          steered: steered ? 1 : 0,
          at,
        });
        return toMessage(row);
      }).pipe(sql.withTransaction),

    get,

    /** Stores unsaved edit text. A waiting message becomes editing; a held one stays held. */
    edit: (sessionId: string, id: string, draft: string) =>
      change(sessionId, id, (message) =>
        setState(id, QueueItemState.$is("held")(message.state) ? "held" : "editing", { draft }),
      ),

    save: (sessionId: string, id: string, text: string) =>
      change(sessionId, id, (message) =>
        setState(id, QueueItemState.$is("held")(message.state) ? "held" : "waiting", { text }),
      ),

    remove: (sessionId: string, id: string) =>
      sql.withTransaction(
        pending(sessionId, id).pipe(
          Effect.andThen(sql`DELETE FROM queued_messages WHERE id = ${id}`),
          Effect.as(null),
        ),
      ),

    confirm: (sessionId: string, id: string) =>
      change(
        sessionId,
        id,
        (message): Effect.Effect<void, QueueChangeRefused | SqlError.SqlError> => {
          const send = () => Effect.asVoid(setState(id, "waiting"));
          const refuse = () => Effect.fail(QueueChangeRefused.make({ id, reason: "not_held" }));
          return QueueItemState.$match(message.state, {
            held: send,
            failed: send,
            waiting: refuse,
            editing: refuse,
            delivered: refuse,
          });
        },
      ),

    /**
     * The messages that may go out now: the waiting ones at the front of the queue. An edited or
     * held message stops delivery at its place, so the order is never changed.
     */
    deliverable: (sessionId: string) =>
      Effect.map(deliverable(sessionId), (rows): ReadonlyArray<QueuedMessage> =>
        rows.map(toMessage),
      ),

    /** Atomically select and reserve the current head until delivery or explicit release. */
    claimNext: (sessionId: string) =>
      MutableHashMap.has(reservations, sessionId)
        ? Effect.succeed(null)
        : Effect.map(head(sessionId), (row) =>
            Option.getOrNull(
              Option.map(
                Option.filter(
                  row,
                  // Checked again after the read: another fibre may have claimed the head meanwhile.
                  (found) =>
                    found.state === "waiting" && !MutableHashMap.has(reservations, sessionId),
                ),
                (found) => {
                  const message = toMessage(found);
                  MutableHashMap.set(reservations, sessionId, {
                    id: message.id,
                    holdOnRelease: false,
                  });
                  return message;
                },
              ),
            ),
          ),

    releaseNext: (sessionId: string, id: string) =>
      Effect.suspend(() =>
        Option.match(
          Option.filter(
            MutableHashMap.get(reservations, sessionId),
            (reservation) => reservation.id === id,
          ),
          {
            onNone: () => Effect.void,
            onSome: (reservation) => {
              MutableHashMap.remove(reservations, sessionId);
              return Effect.asVoid(
                Effect.when(setState(id, "held"), Effect.succeed(reservation.holdOnRelease)),
              );
            },
          },
        ),
      ),

    markDelivered: (id: string, via: Exclude<DeliveryVia, "steer">, runId: string | null) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE queued_messages SET state = 'delivered', delivered_via = ${via}, run_id = ${runId},
            draft = NULL, updated_at = ${yield* now}
          WHERE id = ${id}`;
        Array.from(reservations)
          .filter(([, reservation]) => reservation.id === id)
          .forEach(([sessionId]) => MutableHashMap.remove(reservations, sessionId));
      }),

    markFailed: (id: string, reason: string) =>
      Effect.asVoid(setState(id, "failed", { failure: reason })),

    /**
     * After a cancel or a failed run, waiting messages are not sent on their own any more: they
     * wait for the user to confirm them. When only the page left (`pageLeft`), steered messages
     * keep waiting, since the server sends those itself. Steering takes along every waiting message
     * before it, so the ones held here never stand in front of a steered one.
     */
    holdWaiting: (sessionId: string, cause: "stopped" | "pageLeft") =>
      Effect.gen(function* () {
        // A selected next turn is locked until committed or released. Holding it here would allow
        // a different state to be delivered from the content already selected for this request.
        const reserved = MutableHashMap.get(reservations, sessionId);
        yield* Option.match(reserved, {
          onNone: () => Effect.void,
          onSome: (reservation) =>
            Effect.sync(() =>
              MutableHashMap.set(reservations, sessionId, { ...reservation, holdOnRelease: true }),
            ),
        });
        const reservedId = Option.match(reserved, {
          onNone: () => "",
          onSome: (reservation) => reservation.id,
        });
        yield* sql`
          UPDATE queued_messages SET state = 'held', steered = 0, updated_at = ${yield* now}
          WHERE session_id = ${sessionId} AND state = 'waiting' AND id != ${reservedId}
            AND (${cause === "stopped" ? 1 : 0} OR steered = 0)`;
      }),
  };
});

/** Follow-up messages sent while a run answers, kept in order until they reach the agent. */
export class MessageQueue extends Context.Service<MessageQueue, Effect.Success<typeof make>>()(
  "memory-agent/queue/queue/MessageQueue",
) {
  static readonly layer = Layer.effect(MessageQueue, make).pipe(Layer.provide(NodeCrypto.layer));
}
