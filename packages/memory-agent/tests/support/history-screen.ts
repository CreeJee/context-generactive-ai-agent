// Native SDK boundary: the history page's messages are TanStack's UI messages until step 7.
import { modelMessagesToUIMessages, type ModelMessage } from "@tanstack/ai";
import type { JsonValue } from "../../src/json.ts";

/** The messages of a thread row TanStack wrote. */
const parseTanStackMessages = (text: string): ReadonlyArray<ModelMessage> => JSON.parse(text);

/**
 * The messages the history page shows for a thread's history groups, as JSON: the page reads the
 * group rows as TanStack messages and makes UI messages of them. tools/chat-store-check compares
 * them before and after the row migration (docs/effect-ai-migration.md step 4).
 */
export const historyScreen = (groups: ReadonlyArray<string>): ReadonlyArray<JsonValue> =>
  JSON.parse(JSON.stringify(modelMessagesToUIMessages(groups.flatMap(parseTanStackMessages))));
