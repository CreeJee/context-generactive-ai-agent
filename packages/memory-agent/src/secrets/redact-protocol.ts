import { Schema } from "effect";

/** Messages between the secret sweep and the redaction worker (`redact-worker.ts`). */

export const RedactRequest = Schema.Struct({
  id: Schema.Number,
  /** `json`: texts from a JSON column; secrets are hidden in its strings and the structure kept. */
  kind: Schema.Literals(["text", "json"]),
  texts: Schema.Array(Schema.String),
});
export type RedactRequest = typeof RedactRequest.Type;

export const RedactReply = Schema.Union([
  Schema.Struct({
    id: Schema.Number,
    kind: Schema.Literal("redacted"),
    /** One per text, in the order they were sent. */
    redactions: Schema.Array(Schema.Struct({ text: Schema.String, hidden: Schema.Number })),
  }),
  Schema.Struct({ id: Schema.Number, kind: Schema.Literal("failed"), reason: Schema.String }),
]);
export type RedactReply = typeof RedactReply.Type;
