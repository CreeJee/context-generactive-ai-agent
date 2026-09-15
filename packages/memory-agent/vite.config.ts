import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Workspace-internal: apps import the TypeScript source, so package.json exports stay on src
    // and no declarations are emitted (`vp check` type checks). Declarations also could not name
    // the global `Response` from undici-types, which is not a dependency here.
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
      test: { command: "vp test", dependsOn: [{ task: "build", from: "dependencies" }] },
    },
  },
});
