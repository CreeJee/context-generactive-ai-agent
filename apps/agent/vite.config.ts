import { reactRouter } from "@react-router/dev/vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { lazyPlugins, defineConfig, type HmrContext, type ViteDevServer } from "vite-plus";
import {
  affectsDevelopmentBackend,
  developmentBackendWatchPaths,
  developmentBuildId,
} from "./server/dev-safety.ts";

export default defineConfig(({ command }) => {
  const appRoot = fileURLToPath(new URL(".", import.meta.url));
  const developmentBackend = process.env.CONTEXT_AGENT_DEV_BACKEND;
  const backendBuildId = process.env.CONTEXT_AGENT_BUILD_ID ?? "missing";
  let presentedBuildId = developmentBuildId(appRoot);

  return {
    server: developmentBackend
      ? {
          proxy: {
            "/api": {
              target: developmentBackend,
              configure(proxy) {
                proxy.on("proxyReq", (request) => {
                  request.setHeader("x-context-agent-build-id", presentedBuildId);
                });
              },
            },
          },
        }
      : undefined,
    lint: {
      plugins: ["react", "typescript", "oxc"],
      rules: {
        "react/rules-of-hooks": "error",
        "react/only-export-components": [
          "error",
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
      ...(developmentBackend
        ? [
            {
              name: "context-agent-stable-backend-boundary",
              configureServer(server: ViteDevServer) {
                server.watcher.add(developmentBackendWatchPaths(appRoot));
              },
              handleHotUpdate(context: HmrContext) {
                if (!affectsDevelopmentBackend(context.file)) return;
                presentedBuildId = developmentBuildId(appRoot);
                if (presentedBuildId === backendBuildId) return;
                context.server.config.logger.warn(
                  "\nAgent/backend code changed. Mutations are blocked; restart pnpm dev to apply it safely.\n",
                );
              },
            },
          ]
        : []),
      tailwindcss(),
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
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
              )(readFileSync(process.env.CONTEXT_AGENT_EXE_ASSETS, "utf8")),
            },
          }
        : false,
    },
    run: {
      tasks: {
        // Workspace dependencies build first, down to turbovec's native addon.
        build: {
          command: "react-router build",
          dependsOn: [{ task: "build", from: "dependencies" }],
        },
        bundle: { command: "vp pack", dependsOn: ["build"] },
        // Never cached: Vite Task does not see the files TypeScript 7's native tsc reads, so a cached
        // pass would hide new errors.
        typecheck: { command: "react-router typegen && tsc", cache: false },
        // Never cached: each run builds or starts a fresh executable, and Vite Task's file tracking
        // around the started executable keeps it from serving.
        package: { command: "node scripts/package.ts", dependsOn: ["build"], cache: false },
        "smoke-package": { command: "node scripts/smoke-package.ts", cache: false },
        // macOS only, and only on the machine holding the Developer ID identity.
        notarize: { command: "node scripts/notarize-macos.ts", cache: false },
      },
    },
  };
});
