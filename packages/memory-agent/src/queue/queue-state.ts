/** Browser-safe shapes of the message queue (R03: follow-up messages while a run answers). */

/** How a queued message reached the agent. */
export type DeliveryVia =
  /** Added to the conversation when a tool call returned. */
  | "tool_boundary"
  /** Sent into the answering turn at once (steering). */
  | "steer"
  /** Sent as the next turn after the run completed. */
  | "next_turn";

export type QueueItemState =
  /** Goes out at the next tool-call boundary, or as the next turn when the run completes. */
  | { readonly kind: "waiting" }
  /** Being edited; `draft` is the unsaved text. It and every message after it wait. */
  | { readonly kind: "editing"; readonly draft: string }
  /**
   * Restored after a restart, a cancel, a failed run or the page leaving. Never sent until the user
   * confirms. `draft` is unsaved edit text that was restored with it.
   */
  | { readonly kind: "held"; readonly draft: string | null }
  /** Reached the agent. That is delivery only, not a promise the agent acted on it. */
  | { readonly kind: "delivered"; readonly via: DeliveryVia; readonly runId: string | null }
  | { readonly kind: "failed"; readonly reason: string };

export interface QueuedMessage {
  readonly id: string;
  readonly seq: number;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly state: QueueItemState;
  readonly createdAt: number;
}

/** A change a page asks for on one queued message. */
export type QueueEdit =
  /** Opens (or keeps) the message for editing and stores the unsaved text. */
  | { readonly action: "edit"; readonly draft: string }
  /** Saves the edit: the message keeps its place and waits again (or stays held). */
  | { readonly action: "save"; readonly text: string }
  | { readonly action: "remove" }
  /** Sends a held or failed message after all: it waits for the next delivery point. */
  | { readonly action: "confirm" };
