import { Schema } from "effect";

/** Extra prose and fields can contradict the scored decision, so reject them. */
export const MemoryAnswer = Schema.Struct({
  decision: Schema.String,
  evidenceIds: Schema.Array(Schema.String),
});
export type MemoryAnswer = typeof MemoryAnswer.Type;
