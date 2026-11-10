import { defineConfig } from "vite-plus";

import { wordingExempt, wordingScope } from "./lint/wording/policy.ts";

const agentAndVendoredIgnorePatterns = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".fx/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "lint/anti-slop/**",
];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  staged: {
    "*": "vp check --fix",
    // What Korean wording says: banned phrases, glossary spellings and sentence endings. The check
    // reads only the files lint/wording/policy.ts covers and skips the rest.
    "*.{ts,tsx}": "node lint/wording/check/main.ts check",
  },
  fmt: {
    // Golden files are test output compared byte for byte.
    ignorePatterns: [...agentAndVendoredIgnorePatterns, "**/__golden__/**"],
  },
  lint: {
    ignorePatterns: agentAndVendoredIgnorePatterns,
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./lint/anti-slop/index.ts" },
      {
        name: "anti-slop-effect",
        specifier: "./lint/anti-slop/effect/index.ts",
      },
      { name: "shadcn", specifier: "@shadcn/lint" },
      { name: "allocation", specifier: "./lint/allocation/index.ts" },
      { name: "wording", specifier: "./lint/wording/index.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      // A fold emits through Array.mapAccum or grows a Chunk, HashMap or HashSet; no source disables these.
      "allocation/no-accumulator-copy": "warn",
      "allocation/no-intermediate-array": "warn",
      "allocation/prefer-iterable-grouping": "warn",
      "shadcn/no-restyle": [
        "error",
        {
          allow: ["layout"],
          contracts: [
            // Wrappers the shadcn CLI ships without styles: callers give them their look.
            // Keep components/ui identical to `shadcn add <name> --diff` before adding a name here.
            {
              pattern:
                "^(Collapsible(Trigger|Content)?|TooltipTrigger|DropdownMenuTrigger|HoverCardTrigger)$",
              allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
            },
            // The scroller's content is the conversation column; each screen sets its padding and gaps.
            { pattern: "^MessageScrollerContent$", allow: ["layout", "spacing"] },
          ],
        },
      ],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/require-static-classes": "error",
    },
    overrides: [
      {
        // Design-system components own their appearance and compose each other with classes,
        // as @shadcn/lint recommends for the component directory.
        files: ["apps/agent/app/components/ui/**"],
        rules: {
          "shadcn/no-restyle": "off",
        },
      },
      {
        // Where Korean text may live; scope and exemptions are in lint/wording/policy.ts.
        files: wordingScope,
        rules: {
          "wording/no-raw-korean": "error",
        },
      },
      {
        files: wordingExempt,
        rules: {
          "wording/no-raw-korean": "off",
        },
      },
      {
        // Packages keep collections in Effect's types (docs/map-set-audit-2026-10-06.md).
        files: ["packages/**"],
        rules: {
          "anti-slop-effect/no-native-collections": "error",
        },
      },
      {
        // Native collections these files must keep: a schema walk that tracks visited nodes by
        // reference, and tests that hand Logger.CurrentLoggers the native Set it is typed as.
        files: [
          "packages/memory-agent/src/tools/input-repair.ts",
          "packages/memory-agent/src/memory/native-search/publication.test.ts",
          "packages/memory-agent/tests/model/compatible.test.ts",
          "packages/memory-agent/tests/model/subscription.test.ts",
        ],
        rules: {
          "anti-slop-effect/no-native-collections": "off",
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
