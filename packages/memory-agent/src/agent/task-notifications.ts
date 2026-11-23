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
  notificationsMessage,
  type TaskNotifications,
} from "./orchestrator-message.ts";

/**
 * What a parent session has not been told of: its Work Trace tasks' status notifications and its
 * background tasks' ends. The ends wait in the orchestrator's notifications (sender `task`). A run
 * takes both as it tells the model, and gives them back when it does not finish, so the next run
 * tells them again; a run that finishes delivers the ends it took.
 */
export const taskNotifications = (services: {
  readonly trace: WorkTraceStore["Service"];
  readonly notifications: OrchestratorNotifications["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { trace, notifications, crypto } = services;
  const consume = (sessionId: string, runId: string) =>
    Effect.all({
      tasks: trace.consumeParentNotifications(sessionId, runId),
      background: Effect.map(notifications.claim(sessionId, runId, "task"), (entries) =>
        entries.map(({ payload }): BackgroundEnd => ({
          taskId: payload.taskId,
          parentRunId: payload.parentRunId,
          kind: payload.kind,
          title: payload.title,
          status: payload.status,
        })),
      ),
    });
  const release = (sessionId: string, runId: string) =>
    Effect.all(
      [trace.releaseParentNotifications(sessionId, runId), notifications.release(sessionId, runId)],
      { discard: true },
    );
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
     * the orchestrator's message; when the run fails or is cancelled they go back to the next run.
     * A run that finished delivered the background ends it took; its Work Trace notifications
     * need nothing more.
     */
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: () =>
        consume(sessionId, runId).pipe(
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
      ended: (_scope, end) =>
        (finishedRun(end)
          ? Effect.asVoid(notifications.deliverClaimed(sessionId, runId))
          : release(sessionId, runId)
        ).pipe(Effect.ignore({ log: "Warn" })),
    }),
  };
};
