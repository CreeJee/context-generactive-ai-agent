/** Subagent state as the chat page sees it. Safe to import in the browser. */
import { Schema } from "effect";

export const SubagentStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type SubagentStatus = typeof SubagentStatus.Type;

export const SubagentView = Schema.Struct({
  id: Schema.String,
  /** null for a one-off run. */
  name: Schema.NullOr(Schema.String),
  status: SubagentStatus,
  lastTask: Schema.String,
  lastAnswer: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type SubagentView = typeof SubagentView.Type;
