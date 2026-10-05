import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: {
    entry: { "rrsi-worker": "../../packages/memory-agent/eval/rrsi-worker.ts" },
    outDir: "../../packages/memory-agent/dist/rrsi-evaluator",
    format: "esm",
    platform: "node",
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyImport: [] },
    outputOptions: { codeSplitting: false },
  },
});
