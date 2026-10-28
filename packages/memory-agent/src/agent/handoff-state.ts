// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { sha256 } from "../runtime/synchronous-crypto.ts";
import { Predicate, Schema } from "effect";
import type { ConversationMessage } from "./compaction.ts";
import type { JsonValue } from "../json.ts";

/**
 * The model handoff's saved state and the fingerprints that anchor it, apart from the handoff
 * itself so the startup migration of the TanStack rows reads them without loading the loop.
 */

export const modelHandoffNamespace = "memory-agent/model-handoff";
export const HandoffState = Schema.TaggedUnion({
  baseline: { target: Schema.String },
  handoff: {
    target: Schema.String,
    through: Schema.Int.check(Schema.isGreaterThan(0)),
    anchor: Schema.String,
    anchorId: Schema.optionalKey(Schema.String),
    /** Bounded context earlier versions stored for the cut; no longer sent. */
    context: Schema.optionalKey(Schema.String),
  },
});
export type HandoffState = typeof HandoffState.Type;
export type SavedHandoff = typeof HandoffState.cases.handoff.Type;

export const legacyFingerprint = (message: ConversationMessage | JsonValue | undefined) =>
  sha256(JSON.stringify(message) ?? "missing");

// UI hydration can reorder object fields and fan out tool messages. Hash JSON values
// canonically and locate identified boundaries independently of their array position.
export const fingerprint = (message: ConversationMessage | JsonValue | undefined) =>
  "v2:" +
  sha256(
    JSON.stringify(message, (_key, value) =>
      Predicate.isObject(value) && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
          )
        : value,
    ) ?? "missing",
  );
