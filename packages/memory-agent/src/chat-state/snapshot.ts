import { Array as Arr, Effect, Option, Schema, SchemaTransformation } from "effect";
import { ChatMessage, ChatSnapshot, MessagePart } from "../api/chat-api.ts";
import { StoredInterruptPayload } from "../chat-store/schema.ts";
import { JsonValue } from "../json.ts";

/**
 * The chat API's `snapshot` read from what `reconstructChat` answers a reloaded page
 * (docs/effect-ai-migration.md step 6). Step 7 builds it from the stored thread without TanStack.
 */

/** Older tool results may be content parts. The page shows their text and names the others. */
const ResultContent = Schema.Union([
  Schema.String,
  Schema.Array(
    Schema.Struct({ type: Schema.String, content: Schema.optionalKey(Schema.String) }),
  ).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (parts) => parts.map((part) => part.content ?? `[${part.type}]`).join(""),
        encode: (content) => [{ type: "text", content }],
      }),
    ),
  ),
]);

const StoredPart = Schema.Union([
  ...Object.values(MessagePart.cases).filter((part) => part !== MessagePart.cases["tool-result"]),
  Schema.Struct({ ...MessagePart.cases["tool-result"].fields, content: ResultContent }),
]);

const Reconstructed = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, role: Schema.String, parts: Schema.Array(JsonValue) }),
  ),
  activeRun: ChatSnapshot.fields.activeRun,
  interrupts: Schema.NullOr(
    Schema.Struct({ runId: Schema.String, pending: Schema.Array(JsonValue) }),
  ),
  page: Schema.optionalKey(
    Schema.Struct({ truncated: Schema.Boolean, cursor: Schema.optionalKey(Schema.String) }),
  ),
});

const isShownRole = Schema.is(ChatMessage.fields.role);
// Parts the page does not show, such as subagent cards, are left out. The decoders take parse
// options as their second argument, so they are not passed to `map` as they are.
const decodePart = Schema.decodeUnknownOption(StoredPart);
const decodeInterrupt = Schema.decodeUnknownOption(StoredInterruptPayload);

const toSnapshot = (chat: typeof Reconstructed.Type): ChatSnapshot => {
  const pending = Arr.getSomes(
    (chat.interrupts?.pending ?? []).map((entry) => decodeInterrupt(entry)),
  );
  return {
    messages: chat.messages.flatMap((message) =>
      isShownRole(message.role)
        ? [
            {
              id: message.id,
              role: message.role,
              parts: Arr.getSomes(message.parts.map((part) => decodePart(part))),
            },
          ]
        : [],
    ),
    older: Option.fromNullishOr(chat.page).pipe(
      Option.filter((page) => page.truncated),
      Option.flatMapNullishOr((page) => page.cursor),
      Option.getOrNull,
    ),
    activeRun: chat.activeRun,
    interrupts:
      chat.interrupts !== null && Arr.isArrayNonEmpty(pending)
        ? { runId: chat.interrupts.runId, pending }
        : null,
  };
};

/** Decodes the JSON body `reconstructChat` answered with. */
export const decodeSnapshot = (body: string) =>
  Effect.map(Schema.decodeEffect(Schema.fromJsonString(Reconstructed))(body), toSnapshot);
