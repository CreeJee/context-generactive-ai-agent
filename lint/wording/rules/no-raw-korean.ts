import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

import { catalogFile, linguiMacroModules, promptFile, testFile } from "../policy.ts";

const hangul = /\p{Script=Hangul}/u;

/**
 * Local names a file binds from the Lingui macro modules. `useLingui` hands out its own `t`, so a
 * file importing it may tag templates with `t` too.
 */
function macroNames(program: ESTree.Program): ReadonlySet<string> {
  const imported = program.body.flatMap((statement) =>
    statement.type === "ImportDeclaration" && linguiMacroModules.includes(statement.source.value)
      ? statement.specifiers.map((specifier) => specifier.local.name)
      : [],
  );
  return new Set(imported.includes("useLingui") ? [...imported, "t"] : imported);
}

/** The name a macro tag, call or element is written with, if it is a plain identifier. */
function macroNameOf(node: ESTree.Node): string | undefined {
  if (node.type === "TaggedTemplateExpression" && node.tag.type === "Identifier") {
    return node.tag.name;
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier") return node.callee.name;
  if (node.type === "JSXElement" && node.openingElement.name.type === "JSXIdentifier") {
    return node.openingElement.name.name;
  }
  return undefined;
}

/** Whether `node` or one of its ancestors is a Lingui message (t`…`, msg(…), <Trans>…</Trans>). */
function insideMessage(node: ESTree.Node | null, names: ReadonlySet<string>): boolean {
  if (node === null) return false;
  const name = macroNameOf(node);
  return (name !== undefined && names.has(name)) || insideMessage(node.parent, names);
}

/**
 * Ban Korean text outside the places the wording policy (`lint/wording/policy.ts`) allows: Lingui
 * messages, `copy.ts` catalogs not yet moved to Lingui, and `prompts.ts`. The app speaks Korean
 * only, so Hangul in a string, template or JSX text is wording; keeping it in those places lets the
 * wording check read all of it.
 */
export const noRawKoreanRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow Korean text outside Lingui messages, copy.ts catalogs and prompts.ts (lint/wording/policy.ts).",
    },
    messages: {
      raw: "화면 문구는 Lingui 메시지(t`…`, <Trans>…</Trans>)로 쓰십시오. 모델에 보내는 문장은 prompts.ts에 두십시오. 규칙: lint/wording/policy.ts",
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    if (catalogFile.test(file) || promptFile.test(file) || testFile.test(file)) return {};
    const names = macroNames(context.sourceCode.ast);
    const check = (node: ESTree.Node, text: string) => {
      if (hangul.test(text) && !insideMessage(node, names)) {
        context.report({ node, messageId: "raw" });
      }
    };
    return {
      // Only a string can hold Hangul; numbers, booleans and null print without it.
      Literal(node) {
        check(node, String(node.value));
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((quasi) => quasi.value.raw).join(""));
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
});
