import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { noRawKoreanRule } from "./rules/no-raw-korean.ts";

/** Where Korean text may live. What it may say is the wording check's job (`check/`). */
const wordingPlugin = eslintCompatPlugin({
  meta: { name: "wording" },
  rules: {
    "no-raw-korean": noRawKoreanRule,
  },
});

export default wordingPlugin;
