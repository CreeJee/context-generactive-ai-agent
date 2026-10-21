/** Browser-safe shapes of the message queue (R03: follow-up messages while a run answers). */
import { Data } from "effect";

/** Custom stream event telling the page that queued messages reached the agent in this run. */
export const queueDeliveredEvent = "memory-agent.queue.delivered";

/** How a queued message reached the agent. */
export type DeliveryVia =
  /** Added to the conversation when a tool call returned. */
  | "tool_boundary"
  /** Sent into a codex turn at once. Only older rows have it; codex is no longer a runtime. */
  | "steer"
  /** Sent as the next turn after the run completed. */
  | "next_turn";

export type QueueItemState = Data.TaggedEnum<{
  /**
   * Goes out at the next tool-call boundary, or as the next turn when the run completes. A
   * `steered` message's next turn is started by the server, so it reaches the model even with no
   * page open.
   */
  waiting: { readonly steered: boolean };
  /** Being edited; `draft` is the unsaved text. It and every message after it wait. */
  editing: { readonly draft: string };
  /**
   * Restored after a restart, a cancel, a failed run or the page leaving. Never sent until the user
   * confirms. `draft` is unsaved edit text that was restored with it.
   */
  held: { readonly draft: string | null };
  /** In the model's request: it has read the message, though that does not say it acted on it. */
  delivered: { readonly via: DeliveryVia; readonly runId: string | null };
  failed: { readonly reason: string };
}>;
export const QueueItemState = Data.taggedEnum<QueueItemState>();

export interface QueuedMessage {
  readonly id: string;
  readonly seq: number;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly state: QueueItemState;
  readonly createdAt: number;
}

/** Where the next delivery happens, as `QueueSnapshot.nextDelivery` names it. */
export type NextDelivery = Data.TaggedEnum<{
  ready: {};
  /** The head is steered: the server sends it when the run completes, not the page. */
  server: {};
  blocked: { readonly messageId: string; readonly reason: "editing" | "held" };
  empty: {};
}>;
export const NextDelivery = Data.taggedEnum<NextDelivery>();

/** The server's advisory view of the next delivery point. Delivery reselects current state. */
export interface QueueSnapshot {
  readonly items: QueuedMessage[];
  readonly nextDelivery: NextDelivery;
}

/** A change a page asks for on one queued message. */
export type QueueEdit = Data.TaggedEnum<{
  /** Opens (or keeps) the message for editing and stores the unsaved text. */
  edit: { readonly draft: string };
  /** Saves the edit: the message keeps its place and waits again (or stays held). */
  save: { readonly text: string };
  remove: {};
  /** Sends a held or failed message after all: it waits for the next delivery point. */
  confirm: {};
}>;
export const QueueEdit = Data.taggedEnum<QueueEdit>();
