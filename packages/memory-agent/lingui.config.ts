import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { createSwcExtractor } from "@lingui/native-tools";

/**
 * Server text is written in Korean with the runtime macro (`@lingui/core/runtime-macro`) and resolved
 * through `src/i18n.ts`. The one catalog is the source locale; `lingui extract` fills it for the
 * wording check, and nothing loads it at runtime.
 */
export default defineConfig({
  sourceLocale: "ko",
  locales: ["ko"],
  catalogs: [{ path: "<rootDir>/src/locales/{locale}", include: ["<rootDir>/src"] }],
  format: formatter({ lineNumbers: false }),
  extractors: [createSwcExtractor()],
  experimental: { runtimeMacro: true },
});
