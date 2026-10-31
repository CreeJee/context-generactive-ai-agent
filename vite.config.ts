import { defineConfig } from "vite-plus";

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

const antiSlopRules = {
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
} as const;

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  staged: {
    "*": "vp check --fix",
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
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      ...antiSlopRules,
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
        // Design-system components own their appearance and may need structural values.
        files: ["apps/agent/app/components/ui/**"],
        rules: {
          "shadcn/no-restyle": "off",
          "shadcn/no-arbitrary-values": "off",
          "shadcn/require-static-classes": "off",
        },
      },
      {
        // Code the shadcn CLI writes stays as it ships, so `shadcn add --diff` keeps showing upstream changes.
        files: ["apps/agent/app/components/ui/**", "apps/agent/app/hooks/**"],
        rules: Object.fromEntries(Object.keys(antiSlopRules).map((rule) => [rule, "off"])),
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
