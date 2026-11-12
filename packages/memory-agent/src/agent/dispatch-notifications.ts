import { Effect } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { finishedRun } from "../loop/store.ts";
import type { SessionDispatches } from "../sessions/dispatches.ts";
import { dispatchesMessage } from "./orchestrator-message.ts";

/**
 * What a target conversation's run does with the dispatches other conversations left its session
 * (docs/decisions.md "대상 세션의 다음 run에 전달한다"): it takes the ones still waiting as it
 * tells the model, a claim marking it the run that delivers them, hands them over as the
 * orchestrator's message before the next model call, and settles them when the run ends — the
 * claimed ones delivered when the run finished, given back to wait again when it did not. A run is
 * never started for them: they wait for the next run there is.
 */
export const dispatchNotifications = (services: {
  readonly dispatches: SessionDispatches["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { dispatches, crypto } = services;
  /**
   * Takes the session's waiting dispatches for the run. The store itself keeps a session whose
   * user stopped the notifications from taking anything (decisions.md "대상 세션의 다음 run에
   * 전달한다"), so nothing waits out a run here either.
   */
  const consume = (sessionId: string, runId: string) => dispatches.consume(sessionId, runId);
  return {
    consume,
    /**
     * Before each model call of the run, the dispatches not delivered yet join the conversation as
     * the orchestrator's message; when the run fails or is cancelled they go back to the next run.
     */
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: () =>
        consume(sessionId, runId).pipe(
          Effect.flatMap((claimed) =>
            claimed.length === 0
              ? Effect.succeed<StoredMessage[]>([])
              : Effect.map(
                  Effect.flatMap(crypto.uuidV7(), dispatchesMessage(claimed)),
                  (message): StoredMessage[] => [message],
                ),
          ),
          Effect.mapError(asRunFailed),
        ),
      /** A finished run delivered what it claimed; a run that did not finish gives it back. */
      ended: (_scope, end) =>
        (finishedRun(end)
          ? Effect.asVoid(dispatches.deliverClaimed(sessionId, runId))
          : dispatches.release(sessionId, runId)
        ).pipe(Effect.ignore({ log: "Warn" })),
    }),
  };
};
