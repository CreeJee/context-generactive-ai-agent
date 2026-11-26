import { Effect } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { finishedRun } from "../loop/store.ts";
import type { OrchestratorNotifications } from "../sessions/orchestrator-notifications.ts";
import type { BackgroundEnd } from "../tools/background.ts";
import type { WorkTraceStore } from "../work-trace/store.ts";
import {
  hasTaskNotifications,
  heardBy,
  notificationsMessage,
  toldIn,
  type TaskNotifications,
} from "./orchestrator-message.ts";

/**
 * What a parent session has not been told of: its Work Trace tasks' status notifications and its
 * background tasks' ends. The ends wait in the orchestrator's notifications (sender `task`): one
 * its conversation does not tell yet joins it, and once the run ended and saved its conversation,
 * the ends it delivered are marked delivered. A run takes the Work Trace notifications as it tells
 * the model, and gives them back when it does not finish, so the next run tells them again.
 */
export const taskNotifications = (services: {
  readonly trace: WorkTraceStore["Service"];
  readonly notifications: OrchestratorNotifications["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { trace, notifications, crypto } = services;
  const consume = (sessionId: string, runId: string, conversation: ReadonlyArray<StoredMessage>) =>
    Effect.all({
      tasks: trace.consumeParentNotifications(sessionId, runId),
      background: Effect.map(
        notifications.untold(sessionId, "task", toldIn(conversation).told),
        (entries) =>
          entries.flatMap(({ payload }): BackgroundEnd[] =>
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
      ),
    });
  /** Gives back the Work Trace notifications the run took; the background ends need no giving back. */
  const release = (sessionId: string, runId: string) =>
    Effect.asVoid(trace.releaseParentNotifications(sessionId, runId));
  return {
    consume,
    release,
    /**
     * Whether the session has an end that wakes it (`wake` delivery), unless the user stopped its
     * notifications. A `next_run` end waits for a run that starts anyway.
     */
    wakes: (sessionId: string) =>
      Effect.zipWith(
        trace.wakingParentNotificationSessions,
        notifications.wakes(sessionId),
        (sessions, waking) => waking || sessions.includes(sessionId),
      ),
    /**
     * Before each model call of the run, the notifications not told yet join the conversation as
     * the orchestrator's message. Once the run ended and saved its conversation, the background
     * ends it delivered are marked delivered: all its conversation tells when it finished, else
     * those the model answered. The Work Trace notifications of a run that fails or is cancelled
     * go back to the next run; those of a run that finished need nothing more.
     */
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: (_scope, conversation) =>
        consume(sessionId, runId, conversation).pipe(
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
        Effect.andThen(
          (finishedRun(end) ? Effect.void : release(sessionId, runId)).pipe(
            Effect.ignore({ log: "Warn" }),
          ),
          notifications
            .heard(sessionId, runId, heardBy(end, conversation))
            .pipe(Effect.ignore({ log: "Warn" })),
        ),
    }),
  };
};
