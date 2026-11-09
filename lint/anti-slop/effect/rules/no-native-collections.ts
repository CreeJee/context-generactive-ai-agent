import { defineRule } from "vite-plus/lint/plugins";

/** Native collections that Effect replaces, with the Effect modules to use instead. */
const replacements = {
	Set: "HashSet (built once, then read), MutableHashSet (changed in place) or Array.dedupe",
	Map: "HashMap (built once, or kept in a Ref) or MutableHashMap (changed in place)",
} as const;

/**
 * Keep collections in Effect's types. A native Set or Map belongs only where an SDK, a wire
 * format or a platform API asks for one; the config lists those files.
 */
export const noNativeCollectionsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Disallow new Set and new Map; use Effect's HashSet, HashMap, MutableHashSet or MutableHashMap.",
		},
		messages: {
			nativeCollection:
				"new {{name}} builds a native collection. Use {{replacement}} from effect; keep a native {{name}} only where an SDK or platform API needs one, and list that file in the lint config.",
		},
	},
	createOnce(context) {
		return {
			NewExpression(node) {
				if (node.callee.type !== "Identifier") return;
				const name = node.callee.name;
				if (name !== "Set" && name !== "Map") return;
				context.report({
					node,
					messageId: "nativeCollection",
					data: { name, replacement: replacements[name] },
				});
			},
		};
	},
});
