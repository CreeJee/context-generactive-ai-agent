import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { contentRule } from "./rules/content.ts";

/**
 * What Korean wording says. Where it lives is the official `eslint-plugin-lingui`'s job; scope and
 * exemptions for both are in `policy.ts`.
 */
const wordingPlugin = eslintCompatPlugin({
  meta: { name: "wording" },
  rules: {
    content: contentRule,
  },
});

export default wordingPlugin;
