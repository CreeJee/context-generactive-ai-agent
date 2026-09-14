import type { SQLOutputValue } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";

/**
 * - `allow` / `ask` / `block`: the classifier's (or fallback's) verdict on a call.
 * - `approved` / `denied`: the user's answer to an `ask`.
 */
export const ReviewDecision = Schema.Literal("allow", "ask", "block", "approved", "denied");
export type ReviewDecision = typeof ReviewDecision.Type;

/** `fallback` means the classifier failed and the call went to the user. */
export const ReviewDecider = Schema.Literal("classifier", "fallback", "user");
export type ReviewDecider = typeof ReviewDecider.Type;

export const PermissionReview = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  /** Tool arguments as JSON. */
  input: Schema.String,
  decision: ReviewDecision,
  decidedBy: ReviewDecider,
  reason: Schema.String,
  createdAt: Schema.String,
});
export type PermissionReview = typeof PermissionReview.Type;

export type NewPermissionReview = Omit<PermissionReview, "createdAt">;

const ReviewRow = Schema.Struct({
  session_id: Schema.String,
  tool_call_id: Schema.String,
  tool_name: Schema.String,
  input: Schema.String,
  decision: ReviewDecision,
  decided_by: ReviewDecider,
  reason: Schema.String,
  created_at: Schema.String,
});
const decodeReviewRow = Schema.decodeUnknownSync(ReviewRow);

function toReview(row: Record<string, SQLOutputValue>): PermissionReview {
  const decoded = decodeReviewRow(row);
  return {
    sessionId: decoded.session_id,
    toolCallId: decoded.tool_call_id,
    toolName: decoded.tool_name,
    input: decoded.input,
    decision: decoded.decision,
    decidedBy: decoded.decided_by,
    reason: decoded.reason,
    createdAt: decoded.created_at,
  };
}

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const insert = sqlite.prepare(
    "INSERT INTO permission_reviews (session_id, tool_call_id, tool_name, input, decision, decided_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
  );
  const selectLatest = sqlite.prepare(
    "SELECT * FROM permission_reviews WHERE session_id = ? AND tool_call_id = ? ORDER BY id DESC LIMIT 1",
  );

  return {
    record(review: NewPermissionReview): PermissionReview {
      const row = insert.get(
        review.sessionId,
        review.toolCallId,
        review.toolName,
        review.input,
        review.decision,
        review.decidedBy,
        review.reason,
        new Date().toISOString(),
      );
      if (!row) throw new Error("Permission review insert returned no row");
      return toReview(row);
    },

    /** The decision in force for a call: the user's answer if any, else the verdict. */
    latest(sessionId: string, toolCallId: string): PermissionReview | null {
      const row = selectLatest.get(sessionId, toolCallId);
      return row ? toReview(row) : null;
    },
  };
});

/**
 * Append-only log of who allowed or refused each approval-gated call and why. It is both the
 * state a resumed run reads and the evidence behind a tool result.
 */
export class PermissionReviews extends Context.Tag("memory-agent/PermissionReviews")<
  PermissionReviews,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(PermissionReviews, make);
}
