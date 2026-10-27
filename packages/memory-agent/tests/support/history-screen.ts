import { Option, Schema } from "effect";
import { shownMessage } from "../../src/chat-state/snapshot.ts";
import { StoredHistoryGroup } from "../../src/chat-store/schema.ts";
import type { JsonValue } from "../../src/json.ts";

/** A group's messages; a row TanStack wrote keeps its other fields, which the page never read. */
const decodeGroup = Schema.decodeUnknownOption(Schema.fromJsonString(StoredHistoryGroup));

/**
 * The messages the history page shows for a thread's history groups, one per group as the chat
 * snapshot shows it (src/chat-state/snapshot.ts); a group that does not decode shows as null.
 * tools/chat-store-check compares them before and after the row migration
 * (docs/effect-ai-migration.md step 4).
 */
export const historyScreen = (groups: ReadonlyArray<string>): ReadonlyArray<JsonValue> =>
  groups.map((text) =>
    Option.match(decodeGroup(text), {
      onNone: () => null,
      // The group's id is its first message's, as the projection gives every message one.
      onSome: (messages) => shownMessage({ id: messages[0].id ?? "", messages }),
    }),
  );
