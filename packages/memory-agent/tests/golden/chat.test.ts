import { chatScenarios, goalRestartScenario, goalScenarios, goldenAgent } from "./scenarios.ts";

goldenAgent()("golden chat rows", (it) => {
  chatScenarios(it);
  goalScenarios(it);
});

// A restart replaces the agent, so this block has an agent of its own.
goldenAgent()("golden chat rows across a restart", (it) => {
  // The Goal's next turn writes again once the user continued past the cut run.
  goalRestartScenario({ it, next: (chat) => chat.send("golden:goal-after-restart") });
});
