import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

/**
 * Effect `Array` functions built on `chop`: each cuts one piece and slices the rest of the array
 * for the next cut. `Iterable` has each of them reading the input once.
 */
const choppers: ReadonlyArray<string> = ["groupWith", "group", "chunksOf"];

type Specifier = ESTree.ImportDeclaration["specifiers"][number];

function importedName(specifier: Specifier): string | null {
  if (specifier.type !== "ImportSpecifier") return null;
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : String(specifier.imported.value);
}

/** Local names of Effect's Array module (`Array as Arr`, `* as Arr from "effect/Array"`). */
function arrayModuleNames(program: ESTree.Program): ReadonlyArray<string> {
  return program.body.flatMap((statement) =>
    statement.type === "ImportDeclaration"
      ? statement.specifiers.flatMap((specifier) =>
          (statement.source.value === "effect" && importedName(specifier) === "Array") ||
          (statement.source.value === "effect/Array" &&
            specifier.type === "ImportNamespaceSpecifier")
            ? [specifier.local.name]
            : [],
        )
      : [],
  );
}

/** Local names of the chop-based functions imported one by one from "effect/Array". */
function chopperNames(program: ESTree.Program): ReadonlyArray<string> {
  return program.body.flatMap((statement) =>
    statement.type === "ImportDeclaration" && statement.source.value === "effect/Array"
      ? statement.specifiers.flatMap((specifier) => {
          const name = importedName(specifier);
          return name !== null && choppers.includes(name) ? [specifier.local.name] : [];
        })
      : [],
  );
}

/** The chop-based function `callee` calls, when it is one of Effect's Array module. */
function calledChopper(callee: ESTree.Expression | ESTree.Super, program: ESTree.Program) {
  if (callee.type === "Identifier")
    return chopperNames(program).includes(callee.name) ? callee.name : null;
  return callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    choppers.includes(callee.property.name) &&
    callee.object.type === "Identifier" &&
    arrayModuleNames(program).includes(callee.object.name)
    ? callee.property.name
    : null;
}

/** Ban Effect's chop-based Array grouping, which copies the rest of the array for every piece. */
export const preferIterableGroupingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect's Array.groupWith, Array.group and Array.chunksOf, which copy the rest of the array for every piece they cut.",
    },
    messages: {
      chop: "Effect's Array.{{name}} copies the rest of the array for every piece it cuts, so it allocates pieces × length. Use Iterable.{{name}}, which reads the input once.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = calledChopper(node.callee, context.sourceCode.ast);
        if (name !== null) context.report({ node, messageId: "chop", data: { name } });
      },
    };
  },
});
