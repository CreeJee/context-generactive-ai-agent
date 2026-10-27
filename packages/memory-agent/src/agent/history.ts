import {
  Array as EffectArray,
  DateTime,
  Function as EffectFunction,
  HashSet,
  Match,
  Option,
  Schema,
  String as EffectString,
} from "effect";
import type { Attachment } from "../attachments/attachments.ts";
import { attachmentUrl } from "../attachments/urls.ts";
import type { StoredMessage, StoredToolCall, StoredUserMessage } from "../chat-store/schema.ts";
import type { Node } from "../memory/nodes.ts";
import { optionalProperty } from "../optional-property.ts";

/** The node kinds a conversation shows; the rest are memory the conversation left. */
const isConversation = Schema.is(
  Schema.Literals(["user", "assistant", "tool_call", "tool_result"]),
);

/**
 * Rebuilds the stored thread of a session from its nodes: one user message per user turn (its
 * text, then its images in attachment order), and for each run its answer split at each tool
 * result, every part followed by the result that ended it. A user turn with neither text nor
 * images has nothing to keep and is left out.
 */
export const sessionMessages: {
  (
    attachmentsOf: (nodeId: string) => readonly Attachment[],
  ): (nodes: readonly Node[]) => ReturnType<typeof sessionMessagesBody>;
} & typeof sessionMessagesBody = EffectFunction.dual(2, sessionMessagesBody);
function sessionMessagesBody(
  nodes: readonly Node[],
  attachmentsOf: (nodeId: string) => readonly Attachment[],
): StoredMessage[] {
  return EffectArray.match(
    nodes.filter((node) => isConversation(node.kind)),
    {
      onEmpty: () => [],
      // A user turn is one node; a run is the nodes of one run id between user turns.
      onNonEmpty: (conversation) =>
        EffectArray.groupWith(
          conversation,
          (node, first) =>
            node.kind !== "user" && first.kind !== "user" && node.runId === first.runId,
        ).flatMap((turn) =>
          turn[0].kind === "user"
            ? userMessage(turn[0], attachmentsOf(turn[0].id))
            : runMessages(turn),
        ),
    },
  );
}

const createdAt = (node: Node) => DateTime.formatIso(DateTime.makeUnsafe(node.createdAt));

function userMessage(node: Node, attachments: readonly Attachment[]): StoredMessage[] {
  const images = attachments.map((attachment) => ({
    type: "image" as const,
    source: {
      type: "url" as const,
      value: attachmentUrl(attachment.id),
      mimeType: attachment.mimeType,
    },
  }));
  const text = Option.liftPredicate(node.text, EffectString.isNonEmpty);
  // Text alone is kept as a string, as the user sent it.
  const content: Option.Option<typeof StoredUserMessage.Type.content> =
    EffectArray.isReadonlyArrayNonEmpty(images)
      ? Option.some([
          ...Option.toArray(Option.map(text, (content) => ({ type: "text" as const, content }))),
          ...images,
        ])
      : text;
  return Option.toArray(
    Option.map(content, (content) => ({
      id: node.id,
      role: "user" as const,
      content,
      createdAt: createdAt(node),
    })),
  );
}

/** The run's answer since its last tool result. */
interface Segment {
  readonly texts: ReadonlyArray<string>;
  readonly toolCalls: ReadonlyArray<typeof StoredToolCall.Type>;
}
interface RunState {
  readonly messages: ReadonlyArray<StoredMessage>;
  readonly segment: Segment;
  /** The tool calls whose result is in `messages`; a call keeps its first result. */
  readonly results: HashSet.HashSet<string>;
}
const emptySegment: Segment = { texts: [], toolCalls: [] };

function runMessages(run: EffectArray.NonEmptyReadonlyArray<Node>): ReadonlyArray<StoredMessage> {
  // Every part of the answer has the run's first node's id and time.
  const identity = { id: run[0].id, createdAt: createdAt(run[0]) };
  /** The segment as an assistant message, unless it is empty and not `forced`. */
  const flushed = (state: RunState, forced: boolean): RunState => {
    const { texts, toolCalls } = state.segment;
    const content = texts.length === 0 ? null : texts.join("");
    const answer: StoredMessage = {
      ...identity,
      role: "assistant",
      content,
      ...optionalProperty(
        "toolCalls",
        EffectArray.isReadonlyArrayNonEmpty(toolCalls) ? toolCalls : undefined,
      ),
    };
    return {
      ...state,
      segment: emptySegment,
      messages:
        forced || content !== null || toolCalls.length > 0
          ? EffectArray.append(state.messages, answer)
          : state.messages,
    };
  };
  const step = (state: RunState, node: Node): RunState =>
    Match.value(node.kind).pipe(
      Match.withReturnType<RunState>(),
      Match.when("assistant", () =>
        node.text.length === 0
          ? state
          : {
              ...state,
              segment: {
                ...state.segment,
                texts: EffectArray.append(state.segment.texts, node.text),
              },
            },
      ),
      Match.when("tool_call", () => ({
        ...state,
        segment: {
          ...state.segment,
          toolCalls: EffectArray.append(state.segment.toolCalls, toolCall(node)),
        },
      })),
      // A result ends the segment before it; the run's first result keeps an empty one, so the
      // answer starts before it.
      Match.when("tool_result", () => {
        const before = flushed(state, state.messages.length === 0);
        const toolCallId = node.detail.toolCallId ?? node.id;
        return HashSet.has(before.results, toolCallId)
          ? before
          : {
              ...before,
              messages: EffectArray.append(before.messages, {
                role: "tool",
                content: node.text,
                toolCallId,
              }),
              results: HashSet.add(before.results, toolCallId),
            };
      }),
      Match.orElse(() => state),
    );
  const { messages } = flushed(
    run.reduce(step, { messages: [], segment: emptySegment, results: HashSet.empty() }),
    false,
  );
  // A run that said nothing still answered the user's turn.
  return messages.length === 0 ? [{ ...identity, role: "assistant", content: null }] : messages;
}

function toolCall(node: Node): typeof StoredToolCall.Type {
  const name = node.detail.toolName ?? "";
  // The node's text is the call as the log shows it: the tool's name, then its arguments.
  const prefix = `${name} `;
  return {
    id: node.detail.toolCallId ?? node.id,
    type: "function",
    function: {
      name,
      arguments: node.text.startsWith(prefix) ? node.text.slice(prefix.length) : node.text,
    },
  };
}
