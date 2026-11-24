import { Duration, Effect, MutableRef } from "effect";
import { expect } from "vite-plus/test";
import { ModelUnavailable } from "../../src/providers/contracts.ts";
import { OrchestratorNotifications } from "../../src/sessions/orchestrator-notifications.ts";
import {
  scriptedModel,
  scriptedSource,
  shownScriptedFailure,
} from "../../src/testing/scripted-model.ts";
import { BackgroundTasks } from "../../src/tools/background.ts";
import { selectTestModel } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { testAgent } from "../support/test-env.ts";
import { freshSession, send, until } from "./agent-env.ts";

/** While true no run gets its model, as when the provider went away. */
const modelGone = MutableRef.make(false);
/** How many runs were refused their model. */
const unstarted = MutableRef.make(0);

testAgent({
  testProvider: {
    runModel: (selection, run) =>
      MutableRef.get(modelGone)
        ? Effect.suspend(() => {
            MutableRef.increment(unstarted);
            return Effect.fail(
              ModelUnavailable.make({ provider: "openai", model: selection.model }),
            );
          })
        : Effect.gen(function* () {
            const scripted = yield* scriptedModel([{ text: "hello" }]);
            return {
              model: yield* scripted.forRun(run),
              source: scriptedSource,
              shownFailure: shownScriptedFailure,
              promptCacheFor: Duration.hours(1),
            };
          }),
  },
})("an automatic run that does not start", (it) => {
  it.effect(
    "gives back the ended background task it took, and the next run hears it",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const sessionId = yield* freshSession;
        // An automatic run starts only after the conversation's last run completed.
        yield* send(sessionId, "hello");
        MutableRef.set(modelGone, true);
        const tasks = yield* BackgroundTasks;
        const receipt = yield* tasks.start(
          { sessionId, runId: `${sessionId}:run`, abortSignal: yield* Effect.abortSignal },
          `${sessionId}:call`,
          "shell",
          "pwd",
          Effect.succeed("/"),
        );
        // The automatic run takes the notifications before it prepares its model.
        yield* until(
          () => MutableRef.get(unstarted) > 0,
          "the automatic run to be refused its model",
        );
        yield* until(
          (yield* OrchestratorNotifications).wakes(sessionId),
          "the end to be given back",
        );
        expect(
          yield* sqlGet(
            "SELECT state, claimed_run_id FROM orchestrator_notifications WHERE id = ?",
            receipt.taskId,
          ),
        ).toEqual({ state: "waiting", claimed_run_id: null });
        MutableRef.set(modelGone, false);
        yield* send(sessionId, "next");
        expect(
          yield* sqlGet(
            "SELECT state FROM orchestrator_notifications WHERE id = ?",
            receipt.taskId,
          ),
        ).toEqual({ state: "delivered" });
      }),
    // Each wait may take 6 seconds, longer than a test's default 5.
    15_000,
  );
});
