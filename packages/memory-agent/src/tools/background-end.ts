import { Schema } from "effect";
import { BackgroundKind } from "../agent/run-state.ts";

/** How a background task ended. A command that exited non-zero still completed, with its output. */
export const BackgroundEndedStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** A background task's end, as the orchestrator's notifications keep it until a run tells the model. */
export const BackgroundTaskEnd = Schema.TaggedStruct("BackgroundEnd", {
  taskId: Schema.String,
  /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
  parentRunId: Schema.String,
  kind: BackgroundKind,
  title: Schema.String,
  status: BackgroundEndedStatus,
});
export type BackgroundTaskEnd = typeof BackgroundTaskEnd.Type;
