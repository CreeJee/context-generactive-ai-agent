import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { createSwcExtractor } from "@lingui/native-tools";

/**
 * The production server and command line (`server/`) are bundled by `vp pack`, not Vite, so they
 * write messages with the runtime macro and resolve them through `memory-agent/i18n`, like the
 * server package. Kept apart from `../lingui.config.ts`: turning the runtime macro on there would
 * let the Vite plugin rewrite memory-agent's runtime messages into id-only descriptors.
 */
export default defineConfig({
  rootDir: import.meta.dirname,
  sourceLocale: "ko",
  locales: ["ko"],
  catalogs: [
    { path: "<rootDir>/locales/{locale}", include: ["<rootDir>"], exclude: ["**/tests/**"] },
  ],
  format: formatter({ lineNumbers: false }),
  extractors: [createSwcExtractor()],
  experimental: { runtimeMacro: true },
});
