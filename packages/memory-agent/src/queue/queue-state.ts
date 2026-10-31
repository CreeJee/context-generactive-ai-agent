/** Browser-safe shapes of the message queue (R03: follow-up messages while a run answers). */
import { Data, Schema } from "effect";

/** Custom stream event telling the page that queued messages reached the agent in this run. */
export const queueDeliveredEvent = "memory-agent.queue.delivered";

/**
 * How a queued message reached the agent: `tool_boundary` added to the conversation when a tool
 * call returned, `next_turn` sent as the next turn after the run completed. `steer` sent into a
 * codex turn at once; only older rows have it, since codex is no longer a runtime.
 */
export const DeliveryVia = Schema.Literals(["tool_boundary", "steer", "next_turn"]);
export type DeliveryVia = typeof DeliveryVia.Type;

const ItemState = Schema.TaggedUnion({
  /**
   * Goes out at the next tool-call boundary, or as the next turn when the run completes. A
   * `steered` message's next turn is started by the server, so it reaches the model even with no
   * page open.
   */
  waiting: { steered: Schema.Boolean },
  /** Being edited; `draft` is the unsaved text. It and every message after it wait. */
  editing: { draft: Schema.String },
  /**
   * Restored after a restart, a cancel, a failed run or the page leaving. Never sent until the user
   * confirms. `draft` is unsaved edit text that was restored with it.
   */
  held: { draft: Schema.NullOr(Schema.String) },
  /** In the model's request: it has read the message, though that does not say it acted on it. */
  delivered: { via: DeliveryVia, runId: Schema.NullOr(Schema.String) },
  failed: { reason: Schema.String },
});
export type QueueItemState = typeof ItemState.Type;
export const QueueItemState = Data.taggedEnum<QueueItemState>();

export const QueuedMessage = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
  text: Schema.String,
  attachmentIds: Schema.Array(Schema.String),
  state: ItemState,
  createdAt: Schema.Finite,
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** Where the next delivery happens, as `QueueSnapshot.nextDelivery` names it. */
const Delivery = Schema.TaggedUnion({
  ready: {},
  /** The head is steered: the server sends it when the run completes, not the page. */
  server: {},
  blocked: { messageId: Schema.String, reason: Schema.Literals(["editing", "held"]) },
  empty: {},
});
export type NextDelivery = typeof Delivery.Type;
export const NextDelivery = Data.taggedEnum<NextDelivery>();

/** The server's advisory view of the next delivery point. Delivery reselects current state. */
export const QueueSnapshot = Schema.Struct({
  items: Schema.Array(QueuedMessage),
  nextDelivery: Delivery,
});
export type QueueSnapshot = typeof QueueSnapshot.Type;

/** A change a page asks for on one queued message. */
const Edit = Schema.TaggedUnion({
  /** Opens (or keeps) the message for editing and stores the unsaved text. */
  edit: { draft: Schema.String },
  /** Saves the edit: the message keeps its place and waits again (or stays held). */
  save: { text: Schema.String },
  remove: {},
  /** Sends a held or failed message after all: it waits for the next delivery point. */
  confirm: {},
});
export type QueueEdit = typeof Edit.Type;
export const QueueEdit = Data.taggedEnum<QueueEdit>();
/** A `QueueEdit` as `/api/sessions/:session/queue/:message` reads it. */
export const QueueEditRequest = Edit;
