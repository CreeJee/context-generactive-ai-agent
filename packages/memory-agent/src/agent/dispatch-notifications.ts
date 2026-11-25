import { Effect } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import type { SessionDispatches } from "../sessions/dispatches.ts";
import { dispatchesMessage, heardBy, toldIn } from "./orchestrator-message.ts";

/**
 * What a target conversation's run does with the dispatches other conversations left its session
 * (docs/decisions.md "대상 세션의 다음 run에 전달한다"): the ones still waiting that its conversation
 * does not tell yet join it as the orchestrator's message before the next model call, and once the
 * run ended and saved its conversation, the ones it delivered are marked delivered. A run is never
 * started for them: they wait for the next run there is.
 */
export const dispatchNotifications = (services: {
  readonly dispatches: SessionDispatches["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { dispatches, crypto } = services;
  return {
    /**
     * Before each model call of the run, the dispatches its conversation does not tell yet join it
     * as the orchestrator's message. The store keeps a session whose user stopped the notifications
     * from being given any (decisions.md "대상 세션의 다음 run에 전달한다").
     */
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: (_scope, conversation) =>
        dispatches.untold(sessionId, toldIn(conversation).told).pipe(
          Effect.flatMap((untold) =>
            untold.length === 0
              ? Effect.succeed<StoredMessage[]>([])
              : Effect.map(
                  Effect.flatMap(crypto.uuidV7(), dispatchesMessage(untold)),
                  (message): StoredMessage[] => [message],
                ),
          ),
          Effect.mapError(asRunFailed),
        ),
      /**
       * Once the conversation is saved: a run that finished delivered everything its conversation
       * tells; one that did not delivered what the model answered before it stopped.
       */
      ended: (_scope, end, conversation) =>
        dispatches
          .heard(sessionId, runId, heardBy(end, conversation))
          .pipe(Effect.ignore({ log: "Warn" })),
    }),
  };
};
