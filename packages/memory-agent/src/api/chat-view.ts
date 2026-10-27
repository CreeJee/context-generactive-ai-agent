import { Array as Arr, Function as EffectFunction, HashSet, Option } from "effect";
import { AgUiEvent, reasoningStepMessage, RunOutcome } from "../loop/chunks.ts";
import {
  type ChatMessage,
  type ChatSnapshot,
  MessagePart,
  type PendingInterrupts,
} from "./chat-api.ts";

/**
 * What a page shows of a session, built from its snapshot and the AG-UI events of its runs
 * (docs/effect-ai-migration.md step 6). The messages keep the snapshot's shape, so a message a run
 * writes looks the same once the page reads the session again.
 */

/** Why the last run failed, as its `RUN_ERROR` said. */
export interface RunFailure {
  readonly message: string;
  readonly code: string | null;
}

export interface ChatView {
  /** Oldest first. */
  readonly messages: ReadonlyArray<ChatMessage>;
  /** `before` for the messages older than these, or null when the page has them all. */
  readonly older: string | null;
  readonly interrupts: PendingInterrupts | null;
  readonly failure: RunFailure | null;
  /**
   * The assistant messages the stream being read has written. A stream that rejoins a run reads
   * it from its start, so a message it names for the first time is written again from empty.
   */
  readonly streamed: HashSet.HashSet<string>;
}

/** The view of a session opened with `snapshot`. */
export const viewOf = (snapshot: ChatSnapshot): ChatView => ({
  messages: snapshot.messages,
  older: snapshot.older,
  interrupts: snapshot.interrupts,
  failure: null,
  streamed: HashSet.empty(),
});

/** The view once the page reads a new stream; a reconnect keeps what it has written. */
export const streamStarted = (view: ChatView): ChatView => ({ ...view, streamed: HashSet.empty() });

type Parts = ReadonlyArray<MessagePart>;
type ToolCall = (typeof MessagePart.cases)["tool-call"]["Type"];

const isText = MessagePart.guards.text;
const isThinking = MessagePart.guards.thinking;
const isToolCall = MessagePart.guards["tool-call"];
const isToolResult = MessagePart.guards["tool-result"];

/** Changes assistant message `id`, which is added when it is new. */
const writing = (view: ChatView, id: string, change: (parts: Parts) => Parts): ChatView => {
  const again = !HashSet.has(view.streamed, id);
  const messages = Arr.findLastIndex(view.messages, (message) => message.id === id).pipe(
    Option.flatMap((index) =>
      Arr.modify(view.messages, index, (message) => ({
        ...message,
        parts: change(again ? [] : message.parts),
      })),
    ),
    Option.getOrElse(() => [
      ...view.messages,
      { id, role: "assistant" as const, parts: change([]) },
    ]),
  );
  return { ...view, messages, streamed: HashSet.add(view.streamed, id) };
};

const textAppended =
  (delta: string) =>
  (parts: Parts): Parts =>
    Arr.matchRight(parts, {
      onEmpty: () => [{ type: "text", content: delta }],
      onNonEmpty: (init, last) =>
        isText(last)
          ? [...init, { ...last, content: last.content + delta }]
          : [...parts, { type: "text", content: delta }],
    });

const thinkingAppended =
  (delta: string) =>
  (parts: Parts): Parts =>
    Arr.matchRight(parts, {
      onEmpty: () => [{ type: "thinking", content: delta }],
      onNonEmpty: (init, last) =>
        isThinking(last)
          ? [...init, { ...last, content: last.content + delta }]
          : [...parts, { type: "thinking", content: delta }],
    });

const holdsCall = (toolCallId: string) => (message: ChatMessage) =>
  message.parts.some((part) => isToolCall(part) && part.id === toolCallId);

/** Changes the message that holds call `toolCallId`; an unknown call changes nothing. */
const atCall = (view: ChatView, toolCallId: string, change: (parts: Parts) => Parts): ChatView => ({
  ...view,
  messages: Arr.findLastIndex(view.messages, holdsCall(toolCallId)).pipe(
    Option.flatMap((index) =>
      Arr.modify(view.messages, index, (message) => ({ ...message, parts: change(message.parts) })),
    ),
    Option.getOrElse(() => view.messages),
  ),
});

const callChanged = (view: ChatView, toolCallId: string, change: (call: ToolCall) => ToolCall) =>
  atCall(view, toolCallId, (parts) =>
    parts.map((part) => (isToolCall(part) && part.id === toolCallId ? change(part) : part)),
  );

/** The view after one event of a run. */
export const applyEvent: {
  (event: AgUiEvent): (view: ChatView) => ChatView;
  (view: ChatView, event: AgUiEvent): ChatView;
} = EffectFunction.dual(2, (view: ChatView, event: AgUiEvent): ChatView =>
  AgUiEvent.match(event, {
    RUN_STARTED: () => ({ ...view, interrupts: null, failure: null }),
    RUN_FINISHED: ({ runId, outcome }) => ({
      ...view,
      interrupts:
        outcome !== undefined && RunOutcome.guards.interrupt(outcome)
          ? { runId, pending: outcome.interrupts }
          : null,
    }),
    RUN_ERROR: ({ message, code }) => ({ ...view, failure: { message, code: code ?? null } }),
    TEXT_MESSAGE_START: ({ messageId }) => writing(view, messageId, (parts) => parts),
    TEXT_MESSAGE_CONTENT: ({ messageId, delta }) => writing(view, messageId, textAppended(delta)),
    TEXT_MESSAGE_END: () => view,
    REASONING_START: () => view,
    REASONING_MESSAGE_START: ({ messageId }) =>
      writing(view, reasoningStepMessage(messageId), (parts) => [
        ...parts,
        { type: "thinking", content: "" },
      ]),
    REASONING_MESSAGE_CONTENT: ({ messageId, delta }) =>
      writing(view, reasoningStepMessage(messageId), thinkingAppended(delta)),
    REASONING_MESSAGE_END: () => view,
    REASONING_END: () => view,
    TOOL_CALL_START: ({ toolCallId, toolCallName, parentMessageId }) =>
      writing(view, parentMessageId ?? toolCallId, (parts) => [
        ...parts,
        {
          type: "tool-call",
          id: toolCallId,
          name: toolCallName,
          arguments: "",
          state: "input-streaming",
        },
      ]),
    TOOL_CALL_ARGS: ({ toolCallId, delta }) =>
      callChanged(view, toolCallId, (call) => ({ ...call, arguments: call.arguments + delta })),
    TOOL_CALL_END: ({ toolCallId }) =>
      callChanged(view, toolCallId, (call) => ({ ...call, state: "input-complete" })),
    // A call with its result is complete, as the stored transcript shows it. A resume run answers
    // calls of an earlier run's message, which a replay of that run does not write again.
    TOOL_CALL_RESULT: ({ toolCallId, content }) =>
      atCall(
        callChanged(view, toolCallId, (call) => ({ ...call, state: "complete" })),
        toolCallId,
        (parts) => [
          ...parts.filter((part) => !(isToolResult(part) && part.toolCallId === toolCallId)),
          { type: "tool-result", toolCallId, content, state: "complete" },
        ],
      ),
    CUSTOM: () => view,
  }),
);
