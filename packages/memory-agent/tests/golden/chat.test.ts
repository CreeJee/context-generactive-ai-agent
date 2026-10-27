import { Effect } from "effect";
import { chatScenarios, goalRestartScenario, goalScenarios, goldenAgent } from "./scenarios.ts";

goldenAgent()("golden chat rows", (it) => {
  chatScenarios(it, "");
  goalScenarios(it, "");
});

// A restart replaces the agent, so this block has an agent of its own.
goldenAgent()("golden chat rows across a restart", (it) => {
  // The next Goal turn is left out: the worker's ledger still refuses its first side effect
  // (`uncertain_run`) after the user continued, and the run never ends. The Effect AI loop runs it
  // (`effect-ai.test.ts`).
  goalRestartScenario(it, "", () => Effect.void);
});
