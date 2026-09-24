import { Schema } from "effect";

/**
 * How strongly traversal trusts a hop along each edge kind (0, 1].
 * A found node's utility is its parent's utility times this weight.
 */
export const edgeWeights = {
  // structure: derived by rule when a node is written
  calls: 0.95, // assistant -> tool_call it issued
  returns: 0.95, // tool_call -> its tool_result
  reply: 0.9, // assistant -> user turn it answers
  touches: 0.7, // nodes that refer to the same file or URL
  next: 0.6, // previous node -> next node in the same session
  // llm: added by llm-interpret
  corrects: 0.95, // newer statement -> statement it corrects
  retracts: 0.95, // newer statement -> statement it withdraws
  about: 0.8, // message -> topic node
  related: 0.6, // semantically related, no structural link
} as const;

export const EdgeKind = Schema.Literals([
  "calls",
  "returns",
  "reply",
  "touches",
  "next",
  "corrects",
  "retracts",
  "about",
  "related",
]);
export type EdgeKind = typeof EdgeKind.Type;

export const EdgeOrigin = Schema.Literals(["structure", "llm"]);
export type EdgeOrigin = typeof EdgeOrigin.Type;

export const Edge = Schema.Struct({
  fromId: Schema.String,
  toId: Schema.String,
  kind: EdgeKind,
  origin: EdgeOrigin,
  weight: Schema.Finite,
  createdAt: Schema.String,
});
export type Edge = typeof Edge.Type;

/** Structural links a writer can declare for a new node; `next` and `touches` are derived. */
export interface NodeLink {
  readonly kind: "calls" | "returns" | "reply";
  /** The existing node on the other end. The new node is `to` for calls/returns, `from` for reply. */
  readonly nodeId: string;
}
