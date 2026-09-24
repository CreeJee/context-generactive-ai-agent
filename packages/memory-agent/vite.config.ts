import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
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
      build: { command: "vp pack", dependsOn: [{ task: "build", from: "dependencies" }] },
      test: {
        command: "vp test --maxWorkers=4",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      // Never cached: Vite Task does not see the files TypeScript 7's native tsc reads, so a cached
      // pass would hide new errors.
      typecheck: { command: "tsc", cache: false },
    },
  },
});
