import { chatScenarios, goalRestartScenario, goalScenarios, goldenAgent } from "./scenarios.ts";

// The same scenarios on the Effect AI loop (docs/effect-ai-migration.md steps 4 and 5). Their
// golden files differ from the TanStack ones only where the document lists a difference.
goldenAgent({ chatLoop: "effect-ai" })("golden chat rows on the Effect AI loop", (it) => {
  chatScenarios(it, "effect-ai/");
  goalScenarios(it, "effect-ai/");
});

// A restart replaces the agent, so this block has an agent of its own.
goldenAgent({ chatLoop: "effect-ai" })(
  "golden chat rows across a restart on the Effect AI loop",
  (it) => {
    // The Goal's next turn writes again once the user continued past the cut run.
    goalRestartScenario(it, "effect-ai/", (chat) => chat.send("golden:goal-after-restart"));
  },
);
