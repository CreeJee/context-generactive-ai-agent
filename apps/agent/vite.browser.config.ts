import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    // The board is reached only through the project board test; found mid-run, these were
    // bundled against a second React copy and dnd-kit's hooks failed. Bundle them up front.
    include: ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities", "jotai", "jotai/utils"],
  },
  test: {
    include: [
      "apps/agent/app/entry/navigation/*.browser.tsx",
      "apps/agent/app/entry/chat/message.browser.tsx",
      "apps/agent/app/entry/report/*.browser.tsx",
      "apps/agent/app/entry/chat/btw-panel.browser.tsx",
      "apps/agent/app/entry/chat/board/*.browser.tsx",
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", headless: true }],
    },
  },
});
