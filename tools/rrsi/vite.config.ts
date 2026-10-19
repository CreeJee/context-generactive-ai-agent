import { defineConfig } from "vite-plus";

const bundle = (name: string, entry: string) => ({
  entry: { [name]: entry },
  outDir: "../../packages/memory-agent/dist/rrsi-evaluator",
  clean: false,
  format: "esm" as const,
  platform: "node" as const,
  dts: false,
  deps: { alwaysBundle: [/.*/], onlyImport: [] },
  outputOptions: { codeSplitting: false },
});

export default defineConfig({
  pack: [
    bundle("rrsi-worker", "../../packages/memory-agent/eval/rrsi-worker.ts"),
    // Loading the owner from TypeScript source exceeds its startup timeout in the container.
    bundle(
      "native-search-worker",
      "../../packages/memory-agent/src/memory/native-search/worker.ts",
    ),
  ],
});
