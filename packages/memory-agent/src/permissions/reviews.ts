import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/**
 * - `allow` / `ask` / `block`: the classifier's (or fallback's) verdict on a call.
 * - `approved` / `denied`: the user's answer to an `ask`.
 */
export const ReviewDecision = Schema.Literals(["allow", "ask", "block", "approved", "denied"]);
export type ReviewDecision = typeof ReviewDecision.Type;

/** `fallback` means the classifier failed and the call went to the user. */
export const ReviewDecider = Schema.Literals(["classifier", "fallback", "user"]);
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
function toReview(row: typeof ReviewRow.Type): PermissionReview {
  return {
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: row.input,
    decision: row.decision,
    decidedBy: row.decided_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insert = SqlSchema.findOne({
    Request: PermissionReview,
    Result: ReviewRow,
    execute: (review) => sql`
      INSERT INTO permission_reviews (session_id, tool_call_id, tool_name, input, decision, decided_by, reason, created_at)
      VALUES (${review.sessionId}, ${review.toolCallId}, ${review.toolName}, ${review.input},
        ${review.decision}, ${review.decidedBy}, ${review.reason}, ${review.createdAt})
      RETURNING *`,
  });
  const selectLatest = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, toolCallId: Schema.String }),
    Result: ReviewRow,
    execute: ({ sessionId, toolCallId }) => sql`
      SELECT * FROM permission_reviews
      WHERE session_id = ${sessionId} AND tool_call_id = ${toolCallId}
      ORDER BY id DESC LIMIT 1`,
  });

  return {
    record: (review: NewPermissionReview) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        return toReview(yield* insert({ ...review, createdAt }));
      }),

    /** The decision in force for a call: the user's answer if any, else the verdict. */
    latest: (sessionId: string, toolCallId: string) =>
      Effect.map(selectLatest({ sessionId, toolCallId }), (row) =>
        Option.getOrNull(Option.map(row, toReview)),
      ),
  };
});

/**
 * Append-only log of who allowed or refused each approval-gated call and why. It is both the
 * state a resumed run reads and the evidence behind a tool result.
 */
export class PermissionReviews extends Context.Service<
  PermissionReviews,
  Effect.Success<typeof make>
>()("memory-agent/permissions/reviews/PermissionReviews") {
  static readonly layer = Layer.effect(PermissionReviews, make);
}
