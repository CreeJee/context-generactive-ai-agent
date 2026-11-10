import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { createSwcExtractor } from "@lingui/native-tools";

/**
 * UI text is written in Korean as Lingui macros where it is shown. The app speaks Korean only, so
 * the one catalog is the source locale: `lingui extract` fills it with the messages themselves, and
 * the Vite plugin compiles it when `app/i18n.ts` imports it.
 */
export default defineConfig({
  sourceLocale: "ko",
  locales: ["ko"],
  catalogs: [{ path: "<rootDir>/app/locales/{locale}", include: ["<rootDir>/app"] }],
  // Origins without line numbers: a line number changes with almost every edit around a message.
  format: formatter({ lineNumbers: false }),
  extractors: [createSwcExtractor()],
});
