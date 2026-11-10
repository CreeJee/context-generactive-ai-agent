import { defineRule } from "vite-plus/lint/plugins";

import { linguiCoreMacroModules, linguiJsxMacroModules } from "../policy.ts";
import { checkSource } from "./checker.ts";

const macroModules = [...linguiCoreMacroModules, ...linguiJsxMacroModules];

/**
 * What a Lingui message says: banned phrases, glossary spellings and sentence endings (Kiwi), by the
 * rules in `lint/wording/policy.ts`. Lingui checks none of this. Messages are read with the extractor
 * `lingui extract` uses, so the rule sees exactly what reaches the catalog.
 */
export const contentRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Check what Korean Lingui messages say: banned phrases, glossary and register (lint/wording/policy.ts).",
    },
    messages: {
      violation: '"{{text}}": {{message}} [{{rule}}]',
      unchecked: "문구를 검사하지 못했습니다: {{reason}}",
    },
  },
  create(context) {
    const source = context.sourceCode.text;
    if (!macroModules.some((module) => source.includes(module))) return {};
    return {
      Program(node) {
        const reply = checkSource({ file: context.filename, source });
        if (reply._tag === "Unchecked") {
          context.report({ node, messageId: "unchecked", data: { reason: reply.reason } });
          return;
        }
        reply.findings.forEach(({ line, column, text, rule, message }) =>
          context.report({
            loc: { line, column },
            messageId: "violation",
            data: { text, rule, message },
          }),
        );
      },
    };
  },
});
