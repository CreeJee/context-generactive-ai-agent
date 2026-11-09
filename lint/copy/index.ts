import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { noInlineCopyRule } from "./rules/no-inline-copy.ts";

/** This repository's rules for where app copy lives. What the copy says is tools/copy-check's job. */
const copyPlugin = eslintCompatPlugin({
  meta: { name: "copy" },
  rules: {
    "no-inline-copy": noInlineCopyRule,
  },
});

export default copyPlugin;
