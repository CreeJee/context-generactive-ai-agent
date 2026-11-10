import { defaultExclude, defineConfig } from "vite-plus";

// The memory engine's internals: native search owner and worker, vector index, embedding model,
// ranking plumbing and SQLite locking. They run only through `test:engine`.
const engine = [
  "src/memory/native-search/**/*.test.ts",
  "src/memory/embedding/**/*.test.ts",
  "src/memory/search.test.ts",
  "tests/engine/**/*.test.ts",
];

export default defineConfig({
  test: {
    clearMocks: true,
    // unit: one module's logic beside its source, without a running agent.
    // feature: slices under tests/ that prepare a real agent (TestEnv) or other real resources.
    // engine: the memory engine's internals, kept out of `test`.
    // unit and feature share one module graph per worker (`isolate: false`): importing it again
    // for every file took about a third of the run. Their spies restore themselves; engine
    // replaces a module export for a whole file, so it stays isolated.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...defaultExclude, ...engine],
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: "feature",
          include: ["tests/**/*.test.ts"],
          exclude: [...defaultExclude, ...engine],
          isolate: false,
        },
      },
      { extends: true, test: { name: "engine", include: engine } },
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
      // The Lingui catalog of server text (runtime macro); the commit hook runs `i18n:check`.
      // Never cached: the native extractor's reads are not tracked.
      "i18n:extract": { command: "lingui extract --clean", cache: false },
      "i18n:check": { command: "lingui check sync --clean", cache: false },
      test: {
        command: "vp test --project unit --project feature --maxWorkers=4",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      "test:engine": {
        command: "vp test --project engine --maxWorkers=4",
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
