import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { preferIterableGroupingRule } from "./rules/prefer-iterable-grouping.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("prefer-iterable-grouping", preferIterableGroupingRule, {
  valid: [
    'import { Iterable } from "effect"; Iterable.groupWith(items, same);',
    'import { Chunk } from "effect"; Chunk.chunksOf(items, 2);',
    // Not Effect's Array module.
    "const Arr = { groupWith: () => [] }; Arr.groupWith(items, same);",
    'import { Array as Arr } from "effect"; Arr.groupBy(items, key);',
  ],
  invalid: [
    {
      code: 'import { Array as Arr } from "effect"; Arr.groupWith(items, same);',
      errors: [{ messageId: "chop", data: { name: "groupWith" } }],
    },
    {
      code: 'import * as EffectArray from "effect/Array"; EffectArray.chunksOf(items, 500);',
      errors: [{ messageId: "chop", data: { name: "chunksOf" } }],
    },
    {
      code: 'import { Array } from "effect"; Array.group(items);',
      errors: [{ messageId: "chop", data: { name: "group" } }],
    },
    {
      code: 'import { chunksOf as pieces } from "effect/Array"; pieces(items, 2);',
      errors: [{ messageId: "chop", data: { name: "pieces" } }],
    },
  ],
});
