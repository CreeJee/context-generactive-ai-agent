import { Effect } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { finishedRun } from "../loop/store.ts";
import type { BackgroundTasks } from "../tools/background.ts";
import type { WorkTraceStore } from "../work-trace/store.ts";
import {
  hasTaskNotifications,
  notificationsMessage,
  type TaskNotifications,
} from "./orchestrator-message.ts";

/**
 * What a parent session has not been told of: its Work Trace tasks' status notifications and its
 * background tasks' ends. A run takes them as it tells the model, and gives them back when it
 * does not finish, so the next run tells them again.
 */
export const taskNotifications = (services: {
  readonly trace: WorkTraceStore["Service"];
  readonly background: BackgroundTasks["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { trace, background, crypto } = services;
  const consume = (sessionId: string, runId: string) =>
    Effect.all({
      tasks: trace.consumeParentNotifications(sessionId, runId),
      background: background.consume(sessionId, runId),
    });
  const release = (sessionId: string, runId: string) =>
    Effect.all(
      [trace.releaseParentNotifications(sessionId, runId), background.release(sessionId, runId)],
      { discard: true },
    );
  return {
    consume,
    release,
    /** Whether the session has something to be told, unless the user stopped its notifications. */
    untold: (sessionId: string) =>
      Effect.zipWith(
        trace.pendingParentNotificationSessions,
        background.untold(sessionId),
        (sessions, untold) => untold || sessions.includes(sessionId),
      ),
    /**
     * Before each model call of the run, the notifications not told yet join the conversation as
     * the orchestrator's message; when the run fails or is cancelled they go back to the next run.
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
        Effect.when(release(sessionId, runId), Effect.succeed(!finishedRun(end))).pipe(
          Effect.ignore({ log: "Warn" }),
        ),
    }),
  };
};
