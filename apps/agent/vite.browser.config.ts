import tailwindcss from "@tailwindcss/vite";
import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [
    lingui({ macroTransform: true, configPath: `${import.meta.dirname}/lingui.config.ts` }),
    tailwindcss(),
  ],
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    // The board is reached only through the project board test; found mid-run, these were
    // bundled against a second React copy and dnd-kit's hooks failed. Bundle them up front.
    include: ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities", "jotai", "jotai/utils"],
  },
  test: {
    // Activates the Korean catalog, as the app root does, before any component renders.
    setupFiles: ["apps/agent/app/i18n.ts"],
    include: [
      "apps/agent/app/components/ui/*.browser.tsx",
      "apps/agent/app/entry/navigation/*.browser.tsx",
      "apps/agent/app/entry/chat/message.browser.tsx",
      "apps/agent/app/entry/chat/chat-panel.browser.tsx",
      "apps/agent/app/entry/chat/context-meter.browser.tsx",
      "apps/agent/app/entry/report/*.browser.tsx",
      "apps/agent/app/entry/chat/btw-panel.browser.tsx",
      "apps/agent/app/entry/chat/board/*.browser.tsx",
      "apps/agent/app/entry/settings/pages/*.browser.tsx",
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", headless: true }],
    },
  },
});
