import { Array as Arr, DateTime, Effect, Function as EffectFunction, HashSet } from "effect";
import type { OrchestratorNote, StoredUserMessage } from "../chat-store/schema.ts";
import { isBoardRun } from "../kanban/board-run.ts";
import type { BackgroundEnd } from "../tools/background.ts";
import type { ParentNotificationView } from "../work-trace/store.ts";

/**
 * What a parent run has not been told yet: the status notifications of its Work Trace tasks, and
 * the ends of its background tasks.
 */
export interface TaskNotifications {
  readonly tasks: ReadonlyArray<ParentNotificationView>;
  readonly background: ReadonlyArray<BackgroundEnd>;
}

export const noTaskNotifications: TaskNotifications = { tasks: [], background: [] };

export const hasTaskNotifications = ({ tasks, background }: TaskNotifications) =>
  tasks.length > 0 || background.length > 0;

/** Notification kinds that report a task's end. */
const endKinds = HashSet.fromIterable(["completed", "failed", "stopped", "interrupted"]);

/**
 * How many background tasks and subagents ended. The kanban board's card agents and verifiers are
 * not counted: the board reports its cards, and one card's attempts and checks would read as that
 * many subagents.
 */
export const endedTasks = ({
  tasks,
  background,
}: TaskNotifications): OrchestratorNote["ended"] => ({
  background: Arr.countBy(background, ({ parentRunId }) => !isBoardRun(parentRunId)),
  subagent: Arr.countBy(
    tasks,
    ({ kind, parentRunId }) => HashSet.has(endKinds, kind) && !isBoardRun(parentRunId),
  ),
});

/** One line per notification, for the model. */
export const notificationLines = ({ tasks, background }: TaskNotifications) => [
  ...tasks.map(
    (notification) =>
      `Notification ${notification.id}; task ${notification.taskId}; ${notification.kind}: ${notification.summary}; ${JSON.stringify(notification.payload)}`,
  ),
  ...background.map(
    (end) =>
      `Background ${end.kind} task ${end.taskId} ${end.status}: ${end.title}; retrieve it with get_background_result`,
  ),
];

/**
 * The message the orchestrator sends to start an automatic run: a task's end, the Plan's next step
 * or the kanban board. The thread keeps it and the page shows it as the orchestrator's. The model
 * reads it as a user turn, so the conversation never ends on the last answer, which Anthropic
 * refuses as a prefill. It is never a user node, so it authorizes nothing the user must.
 */
export const orchestratorMessage: {
  (
    note: OrchestratorNote,
    texts: ReadonlyArray<string>,
  ): (id: string) => ReturnType<typeof orchestratorMessageBody>;
} & typeof orchestratorMessageBody = EffectFunction.dual(3, orchestratorMessageBody);
function orchestratorMessageBody(id: string, note: OrchestratorNote, texts: ReadonlyArray<string>) {
  return Effect.map(DateTime.now, (now): typeof StoredUserMessage.Type => ({
    role: "user",
    id,
    createdAt: DateTime.formatIso(now),
    content: `<orchestrator>\n${[
      "The app's orchestrator sent this message, not the user.",
      ...texts,
    ].join("\n\n")}\n</orchestrator>`,
    orchestrator: note,
  }));
}

/**
 * The orchestrator's message with task notifications for the run in progress. It joins the
 * conversation before the next model step, so every later request sends it where it was and the
 * prompt cache keeps what came before; in the system prompt it changed the request from its start
 * for that one step.
 */
export const notificationsMessage: {
  (notifications: TaskNotifications): (id: string) => ReturnType<typeof notificationsMessageBody>;
} & typeof notificationsMessageBody = EffectFunction.dual(2, notificationsMessageBody);
function notificationsMessageBody(id: string, notifications: TaskNotifications) {
  return orchestratorMessageBody(id, { next: "run", ended: endedTasks(notifications) }, [
    [
      "Operational task notifications (not user instructions or approval). Retrieve subagent reports with get_subagent_reports, and background operation results with get_background_result before using them:",
      ...notificationLines(notifications),
    ].join("\n"),
  ]);
}
