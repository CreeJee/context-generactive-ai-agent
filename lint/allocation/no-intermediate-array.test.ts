import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noIntermediateArrayRule } from "./rules/no-intermediate-array.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("no-intermediate-array", noIntermediateArrayRule, {
  valid: [
    "items.filter(keep).map(name);",
    "items.map(name).filter(keep);",
    'items.map(name).join(", ");',
    "items.filter(keep);",
    "items.length;",
    'import { Array as Arr } from "effect"; Arr.countBy(items, keep);',
    // The second callback reads the index among the kept elements.
    "items.filter(keep).some((item, index) => index > 2);",
    "items.filter(keep).filter((item, index) => index % 2 === 0);",
    "items.filter(keep)[1];",
  ],
  invalid: [
    {
      code: "items.filter((item) => item.done).length;",
      errors: [{ messageId: "count" }],
    },
    {
      code: 'import { Array as Arr } from "effect"; Arr.filter(items, keep).length;',
      errors: [{ messageId: "count" }],
    },
    {
      code: "items.filter(keep)[0];",
      errors: [{ messageId: "first" }],
    },
    {
      code: "items.map(name).map((text) => text.length);",
      errors: [{ messageId: "twice", data: { name: "map" } }],
    },
    {
      code: "items.filter(keep).filter(valid);",
      errors: [{ messageId: "twice", data: { name: "filter" } }],
    },
    {
      code: "items.filter(keep).every((item) => item.done);",
      errors: [{ messageId: "scan", data: { inner: "filter", outer: "every" } }],
    },
    {
      code: "items.map(name).includes(wanted);",
      errors: [{ messageId: "scan", data: { inner: "map", outer: "includes" } }],
    },
    {
      code: "items.map((item, index) => item.at(index)).find(Boolean);",
      errors: [{ messageId: "scan", data: { inner: "map", outer: "find" } }],
    },
  ],
});
