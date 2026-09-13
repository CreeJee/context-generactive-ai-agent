import { reactRouter } from "@react-router/dev/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { lazyPlugins, defineConfig } from "vite-plus";

export default defineConfig({
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
    reactRouter(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ]),
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // memory-agent ships TypeScript source; compile it into the server bundle.
    noExternal: ["memory-agent"],
    // Native addons and their loaders must stay as runtime requires.
    external: ["turbovec", "@huggingface/transformers", "onnxruntime-node"],
  },
});
