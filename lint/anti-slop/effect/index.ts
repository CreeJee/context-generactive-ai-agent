import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { noNativeCollectionsRule } from "./rules/no-native-collections.ts";
import { noServiceConstructorImportsRule } from "./rules/no-service-constructor-imports.ts";

/** Opt-in Oxlint rules for Effect service and Layer architecture and Effect collections. */
const antiSlopEffectPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop-effect" },
	rules: {
		"no-native-collections": noNativeCollectionsRule,
		"no-service-constructor-imports": noServiceConstructorImportsRule,
	},
});

export default antiSlopEffectPlugin;
