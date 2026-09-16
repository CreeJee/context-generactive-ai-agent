import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
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
      // Never cached: Vite Task does not see the files TypeScript 7's native tsc reads, so a cached
      // pass would hide new errors.
      typecheck: { command: "tsc", cache: false },
    },
  },
});
