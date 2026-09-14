import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import type { DeliveryVia, QueueItemState, QueuedMessage } from "./queue-state.ts";

const Row = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  text: Schema.String,
  attachment_ids: Schema.parseJson(Schema.Array(Schema.String)),
  state: Schema.Literal("waiting", "editing", "held", "delivered", "failed"),
  draft: Schema.NullOr(Schema.String),
  delivered_via: Schema.NullOr(Schema.Literal("tool_boundary", "steer", "next_turn")),
  run_id: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
});
const decodeRow = Schema.decodeUnknownSync(Row);

function toMessage(raw: Record<string, SQLOutputValue>): QueuedMessage {
  const row = decodeRow(raw);
  let state: QueueItemState;
  switch (row.state) {
    case "waiting":
      state = { kind: "waiting" };
      break;
    case "editing":
      state = { kind: "editing", draft: row.draft ?? row.text };
      break;
    case "held":
      state = { kind: "held", draft: row.draft };
      break;
    case "delivered":
      // The table checks that a delivered row names how it was delivered.
      state = { kind: "delivered", via: row.delivered_via ?? "next_turn", runId: row.run_id };
      break;
    case "failed":
      state = { kind: "failed", reason: row.failure ?? "" };
      break;
  }
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
export class QueueChangeRefused extends Data.TaggedError("QueueChangeRefused")<{
  readonly id: string;
  readonly reason: "not_found" | "delivered" | "not_held";
}> {}

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const now = () => Date.now();
  const get = (sessionId: string, id: string) => {
    const row = sqlite
      .prepare("SELECT * FROM queued_messages WHERE session_id = ? AND id = ?")
      .get(sessionId, id);
    return row ? toMessage(row) : null;
  };
  /** The message, if it may still change (not delivered). */
  const pending = (sessionId: string, id: string) => {
    const message = get(sessionId, id);
    if (!message) return Effect.fail(new QueueChangeRefused({ id, reason: "not_found" }));
    if (message.state.kind === "delivered")
      return Effect.fail(new QueueChangeRefused({ id, reason: "delivered" }));
    return Effect.succeed(message);
  };
  const setState = (
    id: string,
    state: "waiting" | "editing" | "held" | "failed",
    fields: { text?: string; draft?: string | null; failure?: string | null } = {},
  ) =>
    sqlite
      .prepare(
        "UPDATE queued_messages SET state = ?, text = coalesce(?, text), draft = ?, failure = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, fields.text ?? null, fields.draft ?? null, fields.failure ?? null, now(), id);

  // A new process has no page editing and no run to deliver into: what was still on its way is
  // restored for the user to confirm, with any unsaved edit kept as a draft.
  sqlite
    .prepare(
      "UPDATE queued_messages SET state = 'held', updated_at = ? WHERE state IN ('waiting', 'editing')",
    )
    .run(now());

  return {
    /**
     * Messages still to deliver, plus those delivered by `recentRunId` so a page can show them as
     * delivered until its transcript catches up.
     */
    list(sessionId: string, recentRunId: string | null): QueuedMessage[] {
      return sqlite
        .prepare(
          "SELECT * FROM queued_messages WHERE session_id = ? AND (state != 'delivered' OR run_id = ?) ORDER BY seq",
        )
        .all(sessionId, recentRunId)
        .map(toMessage);
    },

    add(sessionId: string, text: string, attachmentIds: readonly string[]): QueuedMessage {
      const row = sqlite
        .prepare(
          `INSERT INTO queued_messages (id, session_id, seq, text, attachment_ids, state, created_at, updated_at)
           VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM queued_messages WHERE session_id = ?), ?, ?, 'waiting', ?, ?)
           RETURNING *`,
        )
        .get(randomUUID(), sessionId, sessionId, text, JSON.stringify(attachmentIds), now(), now());
      if (!row) throw new Error("Queued message insert returned no row");
      return toMessage(row);
    },

    get,

    /** Stores unsaved edit text. A waiting message becomes editing; a held one stays held. */
    edit: (sessionId: string, id: string, draft: string) =>
      Effect.map(pending(sessionId, id), (message) => {
        setState(id, message.state.kind === "held" ? "held" : "editing", { draft });
        return get(sessionId, id);
      }),

    save: (sessionId: string, id: string, text: string) =>
      Effect.map(pending(sessionId, id), (message) => {
        setState(id, message.state.kind === "held" ? "held" : "waiting", { text });
        return get(sessionId, id);
      }),

    remove: (sessionId: string, id: string) =>
      Effect.map(pending(sessionId, id), () => {
        sqlite.prepare("DELETE FROM queued_messages WHERE id = ?").run(id);
        return null;
      }),

    confirm: (sessionId: string, id: string) =>
      Effect.flatMap(pending(sessionId, id), (message) => {
        switch (message.state.kind) {
          case "held":
          case "failed":
            setState(id, "waiting");
            return Effect.succeed(get(sessionId, id));
          case "waiting":
          case "editing":
          case "delivered":
            return Effect.fail(new QueueChangeRefused({ id, reason: "not_held" }));
        }
      }),

    /**
     * The messages that may go out now: the waiting ones at the front of the queue. An edited or
     * held message stops delivery at its place, so the order is never changed.
     */
    deliverable(sessionId: string): QueuedMessage[] {
      const ready: QueuedMessage[] = [];
      for (const message of this.list(sessionId, null)) {
        if (message.state.kind === "failed") continue;
        if (message.state.kind !== "waiting") break;
        ready.push(message);
      }
      return ready;
    },

    markDelivered(id: string, via: DeliveryVia, runId: string | null, inTranscript: boolean) {
      sqlite
        .prepare(
          "UPDATE queued_messages SET state = 'delivered', delivered_via = ?, run_id = ?, in_transcript = ?, draft = NULL, updated_at = ? WHERE id = ?",
        )
        .run(via, runId, inTranscript ? 1 : 0, now(), id);
    },

    markFailed(id: string, reason: string) {
      setState(id, "failed", { failure: reason });
    },

    /** Steered messages the conversation record does not contain yet. */
    steeredOutsideTranscript(sessionId: string, runId: string): QueuedMessage[] {
      return sqlite
        .prepare(
          "SELECT * FROM queued_messages WHERE session_id = ? AND run_id = ? AND delivered_via = 'steer' AND in_transcript = 0 ORDER BY seq",
        )
        .all(sessionId, runId)
        .map(toMessage);
    },

    markInTranscript(ids: readonly string[]) {
      const update = sqlite.prepare("UPDATE queued_messages SET in_transcript = 1 WHERE id = ?");
      for (const id of ids) update.run(id);
    },

    /**
     * After a cancel, a failed run or the page leaving, waiting messages are not sent on their own
     * any more: they wait for the user to confirm them.
     */
    holdWaiting(sessionId: string) {
      sqlite
        .prepare(
          "UPDATE queued_messages SET state = 'held', updated_at = ? WHERE session_id = ? AND state = 'waiting'",
        )
        .run(now(), sessionId);
    },
  };
});

/** Follow-up messages sent while a run answers, kept in order until they reach the agent. */
export class MessageQueue extends Context.Tag("memory-agent/MessageQueue")<
  MessageQueue,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(MessageQueue, make);
}
