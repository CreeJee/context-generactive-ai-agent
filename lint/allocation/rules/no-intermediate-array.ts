import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

/** Calls that read an array once and keep only a yes, an element or a position. */
const scans: ReadonlyArray<string> = ["some", "every", "find", "findIndex", "includes", "indexOf"];

/** `filter` or `map` when `node` calls one of them, as a method or a module function. */
function builder(node: ESTree.Node): "filter" | "map" | null {
  if (node.type !== "CallExpression" || node.arguments.length === 0) return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property.type !== "Identifier") return null;
  const name = callee.property.name;
  return name === "filter" || name === "map" ? name : null;
}

/** The property a member expression reads, when it is a plain name. */
function propertyName(node: ESTree.MemberExpression): string | null {
  return !node.computed && node.property.type === "Identifier" ? node.property.name : null;
}

/**
 * Whether the callback reads the element's index. After `filter`, that index counts the kept
 * elements only, so the two calls do not merge as they are.
 */
function readsIndex(callback: ESTree.Node | undefined): boolean {
  return (
    callback !== undefined &&
    (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression") &&
    callback.params.length >= 2
  );
}

/** Ban a filter or map whose array the next call only counts, scans or maps again. */
export const noIntermediateArrayRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow building an array with filter or map only to count it, take its first element, scan it, or filter or map it again.",
    },
    messages: {
      count:
        "filter builds an array only to count it. Array.countBy(items, predicate) counts without building it.",
      first:
        "filter builds an array only to take its first element. find stops at the first match.",
      twice:
        "The first {{name}} builds an array that the second one reads once and drops. Do both in one {{name}}.",
      scan: "{{inner}} builds an array that {{outer}} reads once and drops. Check each element in one pass instead (combine the conditions, or Array.findFirst with an Option for a mapped value).",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (builder(node.object) !== "filter") return;
        if (propertyName(node) === "length") context.report({ node, messageId: "count" });
        else if (node.computed && node.property.type === "Literal" && node.property.value === 0)
          context.report({ node, messageId: "first" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const inner = builder(callee.object);
        const outer = propertyName(callee);
        if (inner === null || outer === null) return;
        if (inner === "filter" && readsIndex(node.arguments[0])) return;
        if (outer === inner) context.report({ node, messageId: "twice", data: { name: inner } });
        else if (scans.includes(outer))
          context.report({ node, messageId: "scan", data: { inner, outer } });
      },
    };
  },
});
