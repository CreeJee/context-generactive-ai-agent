import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("no-widen-then-assert declaration keys", noWidenThenAssertRule, {
  valid: [
    "const first = second; const second = first; const broad: unknown = first; broad as string;",
    "const value = 'outer'; function inner(value: unknown) { return value as string; }",
    "const broad: unknown = externalValue; broad as string;",
  ],
  invalid: [
    {
      code: "const value = 'known'; const alias = value; const broad: unknown = alias; broad as string;",
      errors: [{ messageId: "widenThenAssert", data: { name: "broad" } }],
    },
    {
      code: "const value = 'outer'; function inner() { const value = 42; const broad: unknown = value; broad as number; }",
      errors: [{ messageId: "widenThenAssert", data: { name: "broad" } }],
    },
  ],
});

tester.run("no-known-value-widening declaration keys", noKnownValueWideningRule, {
  valid: [
    "const first = second; const second = first; const broad: unknown = first;",
    "function inner(value: unknown) { const broad: unknown = value; }",
  ],
  invalid: [
    {
      code: "const value = 42; const alias = value; const broad: unknown = alias;",
      errors: [{ messageId: "widening" }],
    },
    {
      code: "function check(value: unknown): value is string { return true; } const first = 'known'; const alias = first; check(alias);",
      errors: [{ messageId: "widening" }],
    },
  ],
});

tester.run("type alias declaration keys", noUnknownTypeAliasesRule, {
  valid: [
    "type First = Second; type Second = First;",
    "type Value = string; function inner() { type Value = number; type Alias = Value; }",
  ],
  invalid: [
    {
      code: "type Value = unknown; function inner() { type Value = string; type Alias = Value; } type Outer = Value;",
      errors: [
        { messageId: "unknownAlias", data: { alias: "Value" } },
        { messageId: "unknownAlias", data: { alias: "Outer" } },
      ],
    },
  ],
});
