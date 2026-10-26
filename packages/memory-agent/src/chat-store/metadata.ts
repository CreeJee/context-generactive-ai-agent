import type { MetadataStore } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import type { JsonValue } from "../json.ts";

/** Reading or writing chat metadata failed; `cause` is what the store failed with. */
export class ChatMetadataFailed extends Schema.TaggedError<ChatMetadataFailed>()(
  "ChatMetadataFailed",
  { cause: Schema.Defect() },
) {}

/**
 * The `chat_metadata` rows a session keeps beside its conversation, as compaction, model handoff
 * and context usage read and write them. The TanStack runtime and the Effect AI loop each have a
 * store of these rows.
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

const fromPromise = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => ChatMetadataFailed.make({ cause }) });

/** TanStack's store, until step 7 of docs/effect-ai-migration.md. */
export const tanstackMetadata = (store: MetadataStore): ChatMetadata => ({
  get: (namespace, key) => fromPromise(() => store.get(namespace, key)),
  set: (namespace, key, value) => fromPromise(() => store.set(namespace, key, value)),
});
