import {
  Array as EffectArray,
  DateTime,
  Function as EffectFunction,
  Iterable as EffectIterable,
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
  // A user turn is one node; a run is the nodes of one run id between user turns. Iterable's
  // groupWith reads the nodes once; Array's copies the rest of them for every turn it cuts.
  return EffectArray.fromIterable(
    EffectIterable.groupWith(
      nodes.filter((node) => isConversation(node.kind)),
      (first, node) => first.kind !== "user" && node.kind !== "user" && node.runId === first.runId,
    ),
  ).flatMap((turn) =>
    turn[0].kind === "user" ? userMessage(turn[0], attachmentsOf(turn[0].id)) : runMessages(turn),
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

const resultCallId = (node: Node) => node.detail.toolCallId ?? node.id;

function runMessages(run: EffectArray.NonEmptyReadonlyArray<Node>): ReadonlyArray<StoredMessage> {
  // Every part of the answer has the run's first node's id and time.
  const identity = { id: run[0].id, createdAt: createdAt(run[0]) };
  /**
   * The segment (the run's answer between two tool results) as an assistant message, unless it is
   * empty and not `forced`.
   */
  const answer = (segment: ReadonlyArray<Node>, forced: boolean): StoredMessage[] => {
    const texts = segment
      .filter((node) => node.kind === "assistant" && node.text.length > 0)
      .map((node) => node.text);
    const toolCalls = segment.filter((node) => node.kind === "tool_call").map(toolCall);
    const content = texts.length === 0 ? null : texts.join("");
    return forced || content !== null || toolCalls.length > 0
      ? [
          {
            ...identity,
            role: "assistant",
            content,
            ...optionalProperty(
              "toolCalls",
              EffectArray.isReadonlyArrayNonEmpty(toolCalls) ? toolCalls : undefined,
            ),
          },
        ]
      : [];
  };
  const results = run.flatMap((node, index) =>
    node.kind === "tool_result" ? [{ node, index }] : [],
  );
  // A call keeps its first result; a later one still ends the segment before it.
  const firstResults = new Set(
    Object.values(
      EffectArray.groupBy(
        results.map(({ node }) => node),
        resultCallId,
      ),
    ).map((sameCall) => sameCall[0]),
  );
  // A result ends the segment before it; the run's first result keeps an empty one, so the
  // answer starts before it. The nodes after the last result are the final segment.
  const messages = [
    ...results.flatMap(({ node, index }, nth): StoredMessage[] => [
      ...answer(run.slice((results[nth - 1]?.index ?? -1) + 1, index), nth === 0),
      ...(firstResults.has(node)
        ? [{ role: "tool" as const, content: node.text, toolCallId: resultCallId(node) }]
        : []),
    ]),
    ...answer(run.slice((results.at(-1)?.index ?? -1) + 1), false),
  ];
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
