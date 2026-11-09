import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

/** Calls that read an array once and keep only a yes, an element or a position. */
const scans: ReadonlyArray<string> = ["some", "every", "find", "findIndex", "includes", "indexOf"];

/** Constructors that copy what they are given into a collection of their own. */
const constructors: ReadonlyArray<string> = ["Set", "Map", "WeakSet", "WeakMap"];

/** Modules whose `fromIterable` copies its argument into a collection of their own. */
const collectionModules: ReadonlyArray<string> = [
  "HashSet",
  "HashMap",
  "MutableHashSet",
  "MutableHashMap",
  "Chunk",
];

/** The collection a call makes from its argument: `Array.from` or `<Module>.fromIterable`. */
function collectionCall(callee: ESTree.Node): string | null {
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return null;
  const name = propertyName(callee);
  const module = callee.object.name;
  if (module === "Array" && name === "from") return "Array.from";
  return name === "fromIterable" && collectionModules.includes(module)
    ? `${module}.fromIterable`
    : null;
}

/** `filter` or `map` when `node` calls one of them, as a method or a module function. */
function builder(node: ESTree.Node): "filter" | "map" | null {
  if (node.type !== "CallExpression" || node.arguments.length === 0) return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property.type !== "Identifier") return null;
  // Effect's Iterable functions are lazy: they build nothing until something reads them.
  if (callee.object.type === "Identifier" && callee.object.name === "Iterable") return null;
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

/**
 * Ban a filter or map whose array the next call only counts, scans, filters or maps again, or a
 * collection only copies.
 */
export const noIntermediateArrayRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow building an array with filter or map only to count it, take its first element, scan it, or filter or map it again, and mapping elements that a filter then drops.",
    },
    messages: {
      count:
        "filter builds an array only to count it. Array.countBy(items, predicate) counts without building it.",
      first:
        "filter builds an array only to take its first element. find stops at the first match.",
      twice:
        "The first {{name}} builds an array that the second one reads once and drops. Do both in one {{name}}.",
      mapThenFilter:
        "map builds a value for every element, and filter then drops some of them. Filter the source first when the condition reads the source; when it needs the mapped value, use Array.filterMap.",
      scan: "{{inner}} builds an array that {{outer}} reads once and drops. Check each element in one pass instead (combine the conditions, or Array.findFirst with an Option for a mapped value).",
      collection:
        "{{inner}} builds an array that {{collection}} copies once and drops. Pass Iterable.{{inner}}(items, ...) instead, which it reads one element at a time.",
    },
  },
  createOnce(context) {
    /** Reports `source` when it is a filter or map whose array `collection` only copies. */
    const copied = (source: ESTree.Node | undefined, collection: string) => {
      const inner = source === undefined ? null : builder(source);
      if (source === undefined || inner === null) return;
      context.report({ node: source, messageId: "collection", data: { inner, collection } });
    };
    return {
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || !constructors.includes(node.callee.name)) return;
        copied(node.arguments[0], `new ${node.callee.name}`);
      },
      MemberExpression(node) {
        if (builder(node.object) !== "filter") return;
        if (propertyName(node) === "length") context.report({ node, messageId: "count" });
        else if (node.computed && node.property.type === "Literal" && node.property.value === 0)
          context.report({ node, messageId: "first" });
      },
      CallExpression(node) {
        const callee = node.callee;
        const collection = collectionCall(callee);
        if (collection !== null) copied(node.arguments[0], collection);
        if (callee.type !== "MemberExpression") return;
        const inner = builder(callee.object);
        const outer = propertyName(callee);
        if (inner === null || outer === null) return;
        if (inner === "filter" && readsIndex(node.arguments[0])) return;
        if (outer === inner) context.report({ node, messageId: "twice", data: { name: inner } });
        else if (inner === "map" && outer === "filter")
          context.report({ node, messageId: "mapThenFilter" });
        else if (scans.includes(outer))
          context.report({ node, messageId: "scan", data: { inner, outer } });
      },
    };
  },
});
