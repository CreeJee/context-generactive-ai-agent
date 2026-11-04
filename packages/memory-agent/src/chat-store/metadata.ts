import { Effect, Schema } from "effect";
import type { JsonValue } from "../json.ts";

/** Reading or writing chat metadata failed; `cause` is what the store failed with. */
export class ChatMetadataFailed extends Schema.TaggedError<
  ChatMetadataFailed,
  { readonly brand: unique symbol }
>()("ChatMetadataFailed", { cause: Schema.Defect() }) {}

/**
 * A summary of consecutive user turns, from where the previous one ended up to `end` (exclusive,
 * counted from 0). `nextTurnNodeId` is the user node of turn `end`: a conversation whose turn
 * there says something else is not the one summarized, and the summary is not used for it.
 */
export const SummaryBlock = Schema.Struct({
  end: Schema.Finite,
  nextTurnNodeId: Schema.String,
  text: Schema.String,
});
export type SummaryBlock = typeof SummaryBlock.Type;

/**
 * What a session keeps beside its conversation, as compaction, model handoff and context usage
 * read and write it: `chat_metadata` rows, and the session's turn summaries. `RunStore` keeps
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
  /** The session's turn summaries, in the order they were written; none for another thread. */
  readonly summaries: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<SummaryBlock>, ChatMetadataFailed>;
  /** Keeps the session's first `from` summaries and puts `blocks` after them, for the rest. */
  readonly replaceSummaries: (
    sessionId: string,
    from: number,
    blocks: ReadonlyArray<SummaryBlock>,
  ) => Effect.Effect<void, ChatMetadataFailed>;
}
