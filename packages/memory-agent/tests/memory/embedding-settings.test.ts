import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { GlobalConfig } from "../../src/config/global-config.ts";
import { EmbedderRuntime } from "../../src/memory/embedding/embedder.ts";
import { EmbeddingSetup, GpuState } from "../../src/memory/embedding/setup.ts";
import { testAgent } from "../support/test-env.ts";

testAgent()("embedding settings", (it) => {
  it.effect("settings show the choice and what it resolves to, and keep a new choice", () =>
    Effect.gen(function* () {
      const setup = yield* EmbeddingSetup;
      const first = yield* setup.overview;
      const chosen = yield* setup.choose("gpu");
      // The test embedder is not the local model, so nothing is checked.
      expect(first).toMatchObject({
        choice: "auto",
        running: EmbedderRuntime.other(),
        next: "gpu",
      });
      expect(first.gpu).toEqual(GpuState.unchecked());
      expect(chosen).toMatchObject({ choice: "gpu", next: "gpu", gpu: GpuState.unchecked() });
      expect((yield* (yield* GlobalConfig).read).embeddingDevice).toBe("gpu");
    }),
  );
});
