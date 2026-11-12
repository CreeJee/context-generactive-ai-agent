import { Effect, Option, Schema } from "effect";
import type { JsonValue } from "../json.ts";

/** Reading or writing chat metadata failed; `cause` is what the store failed with. */
export class ChatMetadataFailed extends Schema.TaggedError<
  ChatMetadataFailed,
  { readonly brand: unique symbol }
>()("ChatMetadataFailed", { cause: Schema.Defect() }) {}

/**
 * Where a session's summary ends: the first message of the conversation it does not cover. A
 * conversation without that message there is not the one summarized, and the summary is not used
 * for it.
 */
export const SummaryEnd = Schema.TaggedUnion({
  /** User turn `turn`, counted from 0, which memory recorded as node `nodeId`. */
  Turn: { turn: Schema.Int, nodeId: Schema.String },
  /** The step whose first tool call is `callId`. */
  Step: { callId: Schema.String },
});
export type SummaryEnd = typeof SummaryEnd.Type;

/** A session's one summary of its conversation before `end`, rewritten as more is left out. */
export const SessionSummary = Schema.Struct({ text: Schema.String, end: SummaryEnd });
export type SessionSummary = typeof SessionSummary.Type;

/**
 * What a session keeps beside its conversation, as compaction, model handoff and context usage
 * read and write it: `chat_metadata` rows, and the session's summary. `RunStore` keeps
 * them.
 */
export interface ChatMetadata {
  /** The value kept under the key, undecoded; absent when there is none. */
  readonly get: (namespace: string, key: string) => Effect.Effect<unknown, ChatMetadataFailed>;
  readonly set: (
    namespace: string,
    key: string,
    value: JsonValue,
  ) => Effect.Effect<void, ChatMetadataFailed>;
  /** The session's summary; none for another thread or before anything was left out. */
  readonly summary: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<SessionSummary>, ChatMetadataFailed>;
  /**
   * Puts `next` in place of the session's summary when that is still `from`, and says whether it
   * did: a summary written meanwhile from the same one is kept, not overwritten.
   */
  readonly replaceSummary: (
    sessionId: string,
    from: Option.Option<SessionSummary>,
    next: SessionSummary,
  ) => Effect.Effect<boolean, ChatMetadataFailed>;
}
