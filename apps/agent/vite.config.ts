import { reactRouter } from "@react-router/dev/vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { lazyPlugins, defineConfig } from "vite-plus";

export default defineConfig(({ command }) => ({
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: lazyPlugins(() => [
    tailwindcss(),
    // reactRouter() already sets up React and Fast Refresh; adding @vitejs/plugin-react's react()
    // injects the refresh runtime twice ("RefreshRuntime has already been declared").
    reactRouter(),
    babel({ presets: [reactCompilerPreset()] }),
  ]),
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // memory-agent ships TypeScript source; the dev server compiles only it. The production server
    // build carries every JS dependency, so `server/main.ts` and the executable need no node_modules.
    // Native and embedding packages are not imported statically: memory-agent `require`s them from
    // its runtime folder.
    noExternal: command === "build" ? true : ["memory-agent"],
  },
  // `vp pack` after `react-router build`: the production server (`server/main.ts`) with the server
  // build and every JS dependency in one file, `dist/context-agent.mjs`. `vp pack --exe` wraps the
  // same bundle into the executable.
  pack: {
    entry: { "context-agent": "server/main.ts" },
    format: "esm",
    platform: "node",
    outDir: "dist",
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
    // A Node SEA holds one script, so dynamic imports are inlined too.
    outputOptions: { codeSplitting: false },
    // `vp run package` (scripts/package.ts) sets these to also build the executable with the
    // runtime files it has collected as SEA assets.
    exe: process.env.CONTEXT_AGENT_EXE_ASSETS
      ? {
          fileName: "context-agent",
          outDir: process.env.CONTEXT_AGENT_EXE_DIR,
          seaConfig: {
            // The shipped app ignores NODE_OPTIONS, so a developer's or tool's Node flags (preloads,
            // --conditions) cannot change or break it.
            execArgvExtension: "none",
            assets: Schema.decodeUnknownSync(
              Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.String })),
            )(readFileSync(process.env.CONTEXT_AGENT_EXE_ASSETS, "utf8")),
          },
        }
      : false,
  },
  run: {
    tasks: {
      // Never cached: each run builds or starts a fresh executable, and Vite Task's file tracking
      // around the started executable keeps it from serving.
      package: { command: "react-router build && node scripts/package.ts", cache: false },
      "smoke-package": { command: "node scripts/smoke-package.ts", cache: false },
    },
  },
}));
