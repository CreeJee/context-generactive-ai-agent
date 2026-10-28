import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: true,
    // unit: one module's logic beside its source, without a running agent.
    // feature: slices under tests/ that prepare a real agent (TestEnv) or other real resources.
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"] } },
      { extends: true, test: { name: "feature", include: ["tests/**/*.test.ts"] } },
    ],
  },
  pack: {
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
    },
    // Workspace-internal: apps import the TypeScript source, so package.json exports stay on src
    // and no declarations are emitted (`vp check` and the `typecheck` task check types).
    dts: false,
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  run: {
    tasks: {
      // turbovec's addon is built first: the vector index and its tests load it.
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      test: {
        command: "vp test --maxWorkers=4",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      "test:unit": {
        command: "vp test --project unit",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      "test:feature": {
        command: "vp test --project feature --maxWorkers=4",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      // Never cached: Vite Task does not see the files TypeScript 7's native tsc reads, so a cached
      // pass would hide new errors.
      typecheck: { command: "tsc", cache: false },
    },
  },
});
