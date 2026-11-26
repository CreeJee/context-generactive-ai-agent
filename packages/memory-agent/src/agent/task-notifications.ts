import { Effect } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import type {
  NotificationEntry,
  OrchestratorNotifications,
} from "../sessions/orchestrator-notifications.ts";
import type { BackgroundEnd } from "../tools/background.ts";
import {
  hasTaskNotifications,
  heardBy,
  notificationsMessage,
  toldIn,
  type TaskNotifications,
} from "./orchestrator-message.ts";

type TaskEntry = Extract<NotificationEntry, { readonly sender: "task" }>;

/** The task sender's rows as the message builders read them: status changes and background ends. */
const fromEntries = (entries: ReadonlyArray<TaskEntry>): TaskNotifications => ({
  tasks: entries.flatMap(({ id, payload }) =>
    payload._tag === "TaskStatus" ? [{ ...payload, id }] : [],
  ),
  background: entries.flatMap(({ payload }): BackgroundEnd[] =>
    payload._tag === "BackgroundEnd"
      ? [
          {
            taskId: payload.taskId,
            parentRunId: payload.parentRunId,
            kind: payload.kind,
            title: payload.title,
            status: payload.status,
          },
        ]
      : [],
  ),
});

/**
 * What a parent session has not been told of: its Work Trace tasks' status changes and its
 * background tasks' ends. Both wait in the orchestrator's notifications (sender `task`): one its
 * conversation does not tell yet joins it, and once the run ended and saved its conversation, the
 * ones it delivered are marked delivered.
 */
export const taskNotifications = (services: {
  readonly notifications: OrchestratorNotifications["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { notifications, crypto } = services;
  const consume = (sessionId: string, conversation: ReadonlyArray<StoredMessage>) =>
    Effect.map(notifications.untold(sessionId, "task", toldIn(conversation).told), fromEntries);
  return {
    consume,
    /**
     * Whether the session has a notification that wakes it (`wake` delivery), unless the user
     * stopped its notifications. A `next_run` one waits for a run that starts anyway.
     */
    wakes: notifications.wakes,
    /**
     * Before each model call of the run, the notifications its conversation does not tell yet join
     * it as the orchestrator's message. Once the run ended and saved its conversation, those it
     * delivered are marked delivered: all its conversation tells when it finished, else those the
     * model answered.
     */
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: (_scope, conversation) =>
        consume(sessionId, conversation).pipe(
          Effect.flatMap((notifications: TaskNotifications) =>
            hasTaskNotifications(notifications)
              ? Effect.map(
                  Effect.flatMap(crypto.uuidV7(), notificationsMessage(notifications)),
                  (message): StoredMessage[] => [message],
                )
              : Effect.succeed<StoredMessage[]>([]),
          ),
          Effect.mapError(asRunFailed),
        ),
      ended: (_scope, end, conversation) =>
        notifications
          .heard(sessionId, runId, heardBy(end, conversation))
          .pipe(Effect.ignore({ log: "Warn" })),
    }),
  };
};
