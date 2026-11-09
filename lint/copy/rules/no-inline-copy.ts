import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const hangul = /\p{Script=Hangul}/u;

/** Copy catalogs: the only files where app copy is written. */
const catalogFile = /(^|\/)copy\.ts$/;

/** Tests may spell the copy they look for on screen. */
const testFile = /\.(test|spec)\.tsx?$/;

/**
 * Ban Korean copy written outside a `copy.ts` catalog. The app speaks Korean only, so Hangul in a
 * string, template or JSX text is copy; keeping it in catalogs lets tools/copy-check read all of it.
 */
export const noInlineCopyRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow Korean copy in string literals, template literals and JSX text outside copy.ts catalogs.",
    },
    messages: {
      inline:
        "UI 문구는 같은 기능 폴더의 copy.ts에 두고 거기서 가져오세요. copy.ts의 문구는 tools/copy-check가 검사합니다.",
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    if (catalogFile.test(file) || testFile.test(file)) return {};
    const report = (node: ESTree.Node) => context.report({ node, messageId: "inline" });
    return {
      // Only a string can hold Hangul; numbers, booleans and null print without it.
      Literal(node) {
        if (hangul.test(String(node.value))) report(node);
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => hangul.test(quasi.value.raw))) report(node);
      },
      JSXText(node) {
        if (hangul.test(node.value)) report(node);
      },
    };
  },
});
