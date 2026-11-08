import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

/** Calls whose callback folds a collection into an accumulator, one step per element. */
const folds: ReadonlyArray<string> = ["reduce", "reduceRight", "runFold", "runFoldEffect"];
/** Effect Array functions that return a copy of their first argument with elements added. */
const copyingAdds: ReadonlyArray<string> = ["append", "appendAll", "prepend", "prependAll"];
/** Modules whose adds share structure instead of copying, so a fold may use them. */
const sharingModules: ReadonlyArray<string> = ["Chunk"];

type Callee = ESTree.Expression | ESTree.Super;

/** The called function's name: a bare identifier, or the property of a static member access. */
function calleeName(callee: Callee): string | null {
  if (callee.type === "Identifier") return callee.name;
  return callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
    ? callee.property.name
    : null;
}

function isSharingModule(callee: Callee): boolean {
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    sharingModules.includes(callee.object.name)
  );
}

/** The names a reducer's first parameter binds: the accumulator, or its destructured fields. */
function accumulatorNames(parameter: ESTree.ParamPattern | undefined): ReadonlyArray<string> {
  if (parameter?.type === "Identifier") return [parameter.name];
  if (parameter?.type !== "ObjectPattern") return [];
  return parameter.properties.flatMap((property) =>
    property.type === "Property" && property.value.type === "Identifier"
      ? [property.value.name]
      : [],
  );
}

/** The accumulator names of `node` when it is a reducer passed to a fold call. */
function reducerAccumulators(node: ESTree.Node): ReadonlyArray<string> {
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return [];
  const call = node.parent;
  const name = call.type === "CallExpression" ? calleeName(call.callee) : null;
  return call.type === "CallExpression" &&
    name !== null &&
    folds.includes(name) &&
    call.arguments.includes(node) &&
    node.params.length >= 2
    ? accumulatorNames(node.params[0])
    : [];
}

/** The accumulator names of every reducer around `node`, innermost first. */
function accumulatorsAround(node: ESTree.Node): ReadonlyArray<string> {
  const own = reducerAccumulators(node);
  return node.parent === null ? own : [...own, ...accumulatorsAround(node.parent)];
}

/** Whether `expression` is an accumulator, or a field read from one (`state.messages`). */
function readsAccumulator(expression: ESTree.Node, names: ReadonlyArray<string>): boolean {
  if (expression.type === "Identifier") return names.includes(expression.name);
  if (expression.type === "MemberExpression") return readsAccumulator(expression.object, names);
  if (expression.type === "TSNonNullExpression" || expression.type === "ParenthesizedExpression")
    return readsAccumulator(expression.expression, names);
  return false;
}

/** The array a call copies with elements added: `append(acc, x)` or `acc.concat(x)`. */
function copiedByCall(node: ESTree.CallExpression): ESTree.Node | null {
  const name = calleeName(node.callee);
  const first = node.arguments[0];
  if (
    name !== null &&
    copyingAdds.includes(name) &&
    !isSharingModule(node.callee) &&
    node.arguments.length >= 2 &&
    first !== undefined &&
    first.type !== "SpreadElement"
  )
    return first;
  return name === "concat" && node.callee.type === "MemberExpression" ? node.callee.object : null;
}

/** Ban copying a growing accumulator on every step of a fold. */
export const noAccumulatorCopyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow copying the accumulator on each step of reduce or fold, which allocates in proportion to the square of its length.",
    },
    messages: {
      copy: "Each fold step copies the whole accumulator here, so the fold allocates in proportion to the square of its length. Build the result once (map, filter, flatMap, groupBy), emit per element with Array.mapAccum, or keep the accumulator in a collection that shares structure (Chunk, HashMap, HashSet).",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const copied = copiedByCall(node);
        if (copied !== null && readsAccumulator(copied, accumulatorsAround(node)))
          context.report({ node, messageId: "copy" });
      },
      ArrayExpression(node) {
        const names = accumulatorsAround(node);
        if (
          names.length > 0 &&
          node.elements.some(
            (element) =>
              element?.type === "SpreadElement" && readsAccumulator(element.argument, names),
          )
        )
          context.report({ node, messageId: "copy" });
      },
    };
  },
});
