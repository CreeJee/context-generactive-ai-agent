import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { noNativeCollectionsRule } from "./rules/no-native-collections.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("no-native-collections", noNativeCollectionsRule, {
	valid: [
		'import { HashSet } from "effect"; HashSet.fromIterable(items);',
		'import { MutableHashMap } from "effect"; MutableHashMap.empty<string, number>();',
		// Identity caches have no Effect counterpart.
		"new WeakMap<object, string>();",
		"new WeakSet<object>();",
		"const text = 'new Set(items)';",
		"function read(ids: ReadonlySet<string>) { return ids.size; }",
	],
	invalid: [
		{
			code: "new Set(items);",
			errors: [{ messageId: "nativeCollection" }],
		},
		{
			code: "const byId = new Map<string, number>();",
			errors: [{ messageId: "nativeCollection" }],
		},
		{
			code: "const unique = [...new Set(items)];",
			errors: [{ messageId: "nativeCollection" }],
		},
	],
});
