import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { noAccumulatorCopyRule } from "./rules/no-accumulator-copy.ts";
import { noIntermediateArrayRule } from "./rules/no-intermediate-array.ts";
import { preferIterableGroupingRule } from "./rules/prefer-iterable-grouping.ts";

/** This repository's rules against code that allocates far more than its result needs. */
const allocationPlugin = eslintCompatPlugin({
  meta: { name: "allocation" },
  rules: {
    "no-accumulator-copy": noAccumulatorCopyRule,
    "no-intermediate-array": noIntermediateArrayRule,
    "prefer-iterable-grouping": preferIterableGroupingRule,
  },
});

export default allocationPlugin;
