import { Effect, Schema } from "effect";
import type { JsonValue } from "../json.ts";

/** Reading or writing chat metadata failed; `cause` is what the store failed with. */
export class ChatMetadataFailed extends Schema.TaggedError<
  ChatMetadataFailed,
  { readonly brand: unique symbol }
>()("ChatMetadataFailed", { cause: Schema.Defect() }) {}

/**
 * The `chat_metadata` rows a session keeps beside its conversation, as compaction, model handoff
 * and context usage read and write them. `RunStore` keeps these rows.
 */
export interface ChatMetadata {
  /** The value kept under the key, undecoded; absent when there is none. */
  readonly get: (namespace: string, key: string) => Effect.Effect<unknown, ChatMetadataFailed>;
  readonly set: (
    namespace: string,
    key: string,
    value: JsonValue,
  ) => Effect.Effect<void, ChatMetadataFailed>;
}
