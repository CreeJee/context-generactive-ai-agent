import { chatScenarios, goalRestartScenario, goalScenarios, goldenAgent } from "./scenarios.ts";

// Every Goal run is on the Effect AI loop whatever `ChatLoop` says (docs/effect-ai-migration.md
// step 5), so its golden files are the Effect AI loop's.
goldenAgent()("golden chat rows", (it) => {
  chatScenarios(it, "");
  goalScenarios(it, "effect-ai/");
});

// A restart replaces the agent, so this block has an agent of its own.
goldenAgent()("golden chat rows across a restart", (it) => {
  // The Goal's next turn writes again once the user continued past the cut run.
  goalRestartScenario(it, "effect-ai/", (chat) => chat.send("golden:goal-after-restart"));
});
