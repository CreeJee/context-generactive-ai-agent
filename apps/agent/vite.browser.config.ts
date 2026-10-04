import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { tsconfigPaths: true },
  test: {
    include: [
      "apps/agent/app/entry/navigation/*.browser.tsx",
      "apps/agent/app/entry/chat/message.browser.tsx",
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", headless: true }],
    },
  },
});
