import { Array as Arr, Effect, Match, Option, Schema } from "effect";
import { type ChatMessage, type ChatSnapshot, MessagePart } from "../api/chat-api.ts";
import {
  type StoredAssistantMessage,
  StoredHistoryGroup,
  type StoredMessage,
  type StoredToolCall,
  type StoredToolMessage,
  type StoredUserMessage,
  TextPart,
} from "../chat-store/schema.ts";
import { RunStore } from "../loop/store.ts";
import { HistoryPageUnavailable } from "./history-projection-native.ts";
import { HistoryPageRequest, HistoryPageSnapshot } from "./history-projection-reader.ts";

/**
 * The chat API's `snapshot` (docs/effect-ai-migration.md step 7): a page of the history projection,
 * each group shown as one message the way TanStack's `modelMessagesToUIMessages` showed it, with the
 * run still going and the approvals the thread waits for.
 */

const decodeGroup = Schema.decodeEffect(Schema.fromJsonString(StoredHistoryGroup));
const isText = Schema.is(Schema.String);
const isTextPart = Schema.is(TextPart);
const isCall = MessagePart.guards["tool-call"];

/** Text the page shows; empty text shows nothing. */
const textParts = (content: string): ReadonlyArray<MessagePart> =>
  content === "" ? [] : [{ type: "text", content }];

const userParts = (content: (typeof StoredUserMessage.Type)["content"]) =>
  isText(content) ? textParts(content) : content;

const callPart = (call: typeof StoredToolCall.Type): MessagePart => ({
  type: "tool-call",
  id: call.id,
  name: call.function.name,
  arguments: call.function.arguments,
  state: "input-complete",
});

/** Thinking with neither text nor a signature is left out. */
const assistantParts = (
  message: typeof StoredAssistantMessage.Type,
): ReadonlyArray<MessagePart> => [
  ...(message.thinking ?? [])
    .filter(({ content, signature }) => content !== "" || (signature ?? "") !== "")
    .map(({ content }): MessagePart => ({ type: "thinking", content })),
  ...textParts(message.content ?? ""),
  ...(message.toolCalls ?? []).map(callPart),
];

/** A result's text; a part that is not text shows as its kind. */
const resultText = (content: (typeof StoredToolMessage.Type)["content"]) =>
  isText(content)
    ? content
    : content.map((part) => (isTextPart(part) ? part.content : `[${part.type}]`)).join("");

/** A result follows the parts of the message that made the call, which it completes. */
const withResult = (
  parts: ReadonlyArray<MessagePart>,
  message: typeof StoredToolMessage.Type,
): ReadonlyArray<MessagePart> => {
  const state: "complete" | "error" = message.error === undefined ? "complete" : "error";
  return [
    ...parts.map((part) =>
      isCall(part) && part.id === message.toolCallId ? { ...part, state } : part,
    ),
    {
      type: "tool-result",
      toolCallId: message.toolCallId,
      content: resultText(message.content),
      state,
    },
  ];
};

const partsAfter = (parts: ReadonlyArray<MessagePart>, message: StoredMessage) =>
  Match.value(message).pipe(
    Match.discriminatorsExhaustive("role")({
      user: ({ content }) => [...parts, ...userParts(content)],
      assistant: (assistant) => [...parts, ...assistantParts(assistant)],
      tool: (tool) => withResult(parts, tool),
    }),
  );

/** One group as the page shows it; a result without its call is the assistant's. */
export const shownMessage = ({
  id,
  messages,
}: {
  readonly id: string;
  readonly messages: Arr.NonEmptyReadonlyArray<StoredMessage>;
}): ChatMessage => ({
  id,
  role: messages[0].role === "user" ? "user" : "assistant",
  parts: messages.reduce(partsAfter, []),
});

const noMessages: Pick<ChatSnapshot, "messages" | "older"> = { messages: [], older: null };

/** The newest `limit` messages of the thread, or those before `before`, and what it waits on. */
export const chatSnapshot = Effect.fn("chatSnapshot")(function* (
  threadId: string,
  limit: number,
  before: string | undefined,
) {
  const store = yield* RunStore;
  const page = yield* store.historyPage(
    before === undefined
      ? HistoryPageRequest.cases.initial.make({ threadId, limit })
      : HistoryPageRequest.cases.older.make({ threadId, limit, before }),
  );
  const shownPage = yield* HistoryPageSnapshot.match(page, {
    // A thread never saved has nothing to show yet; a saved one must have its pages.
    "not-ready": () =>
      store.threadSaved(threadId).pipe(
        Effect.filterOrFail(
          (saved) => !saved,
          () => HistoryPageUnavailable.make({ reason: "not-ready" }),
        ),
        Effect.as(noMessages),
      ),
    "unknown-cursor": () => Effect.succeed(noMessages),
    page: ({ groups, nextCursor }) =>
      Effect.map(
        Effect.forEach(groups, ({ uiId, messages }) =>
          Effect.map(decodeGroup(messages), (group) => shownMessage({ id: uiId, messages: group })),
        ),
        (messages) => ({ messages, older: nextCursor }),
      ),
  });
  const pending = yield* store.pendingInterrupts(threadId);
  return {
    ...shownPage,
    activeRun: Option.getOrNull(
      Option.map(yield* store.activeRun(threadId), (runId) => ({ runId })),
    ),
    interrupts: Arr.isArrayNonEmpty(pending)
      ? { runId: pending[0].runId, pending: Arr.map(pending, ({ payload }) => payload) }
      : null,
  } satisfies ChatSnapshot;
});
