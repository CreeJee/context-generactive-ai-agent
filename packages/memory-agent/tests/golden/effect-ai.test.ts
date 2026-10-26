import { chatScenarios, goldenAgent } from "./scenarios.ts";

// The same scenarios on the Effect AI loop (docs/effect-ai-migration.md step 4). Their golden
// files differ from the TanStack ones only where the document lists a difference.
goldenAgent({ chatLoop: "effect-ai" })("golden chat rows on the Effect AI loop", (it) => {
  chatScenarios(it, "effect-ai/");
});
