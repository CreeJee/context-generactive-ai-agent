import { Schema } from "effect";
import { CardStatus } from "./card.ts";

/**
 * Plans and boards as the page reads them. This module imports no server code, so the browser
 * bundle can use it; `workflow.ts` and `board.ts` keep them.
 */

export const PlanStatus = Schema.Literals([
  "draft",
  "ready",
  "executing",
  "completed",
  "blocked",
  "closed",
]);
export type PlanStatus = typeof PlanStatus.Type;

/** A Plan without its steps, as boards show it. */
export const PlanSummary = Schema.Struct({
  version: Schema.Int,
  status: PlanStatus,
  summary: Schema.String,
});
export type PlanSummary = typeof PlanSummary.Type;

/** `GET /api/projects/:project/boards`: one conversation's Plan as a board, without its cards. */
export const ProjectBoard = Schema.Struct({
  sessionId: Schema.String,
  sessionTitle: Schema.NullOr(Schema.String),
  plan: PlanSummary,
  /** Cards in each column. */
  counts: Schema.Record(CardStatus, Schema.Finite),
  /** Whether the session's current Goal runs as an active kanban board. */
  kanbanActive: Schema.Boolean,
  /** When the Plan was last saved. */
  updatedAt: Schema.String,
  /** The conversation's place among the project's Goals in the priority tree, from 0. */
  rank: Schema.Finite,
});
export type ProjectBoard = typeof ProjectBoard.Type;
