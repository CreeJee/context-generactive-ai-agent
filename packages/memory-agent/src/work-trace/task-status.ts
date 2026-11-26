import { Schema } from "effect";
import { JsonValue } from "../json.ts";

/** What a Work Trace task's status change reports. */
export const TaskStatusKind = Schema.Literals([
  "stopped",
  "interrupted",
  "archived",
  "deleted",
  "resume_blocked",
  "resumed",
  "completed",
  "failed",
]);
export type TaskStatusKind = typeof TaskStatusKind.Type;

/**
 * A Work Trace task's status change, as the orchestrator's notifications keep it until the model
 * answers the message that tells it.
 */
export const TaskStatusChange = Schema.TaggedStruct("TaskStatus", {
  taskId: Schema.String,
  /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
  parentRunId: Schema.String,
  kind: TaskStatusKind,
  summary: Schema.String,
  /** What the change carries besides its words, such as the attempt and why it failed. */
  detail: Schema.Record(Schema.String, JsonValue),
});
export type TaskStatusChange = typeof TaskStatusChange.Type;

/** A status change with the id of the notification that carries it. */
export type TaskStatusNotification = TaskStatusChange & { readonly id: string };
