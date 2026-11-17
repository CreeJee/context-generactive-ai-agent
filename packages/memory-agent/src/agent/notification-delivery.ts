import { Schema } from "effect";
import { isBoardRun } from "../kanban/board-run.ts";

/**
 * How the conversation hears that a task ended, chosen when the task starts and kept with it.
 * `wake` starts the conversation's next run once nothing runs there; `next_run` waits for a run
 * that starts anyway. Either way a run tells every end it finds, so a `next_run` end goes along
 * with the next one.
 */
export const NotificationDelivery = Schema.Literals(["wake", "next_run"]);
export type NotificationDelivery = typeof NotificationDelivery.Type;

/**
 * The delivery a task gets from the run that starts it. A chat run's model hears of the end only in
 * a run, so it is woken. The kanban board follows its own cards and asks the model when it needs
 * it, so a task one of its runs started does not wake the conversation.
 */
export const deliveryFor = (parentRunId: string): NotificationDelivery =>
  isBoardRun(parentRunId) ? "next_run" : "wake";
