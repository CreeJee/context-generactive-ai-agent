import { Cause, Effect, Function as EffectFunction, Option } from "effect";
import {
  requestHistory,
  type Budget,
  type CompactionSources,
  type ConversationMessage,
} from "../../src/agent/compaction.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { RunStore } from "../../src/loop/store.ts";
import { type Node, Nodes } from "../../src/memory/nodes.ts";

export const call = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

export const noLimit = 1_000_000;

export const sourcesOf: {
  (sessionId: string): (nodes: Nodes["Service"]) => CompactionSources;
  (nodes: Nodes["Service"], sessionId: string): CompactionSources;
} = EffectFunction.dual(2, (nodes: Nodes["Service"], sessionId: string): CompactionSources => ({
  toolResultIds: (toolCallIds) => nodes.toolResultIds(sessionId, toolCallIds),
  nodeTexts: nodes.texts,
}));

/** What the model is sent next, under automatic compaction alone. */
export const nextRequest = Effect.fnUntraced(function* (
  messages: ReadonlyArray<ConversationMessage>,
  sessionId: string,
  budget: Budget = { compactAt: noLimit, leaveOutAt: noLimit },
) {
  const sent = yield* requestHistory({
    metadata: (yield* RunStore).chatMetadata,
    threadId: sessionId,
    messages,
    restored: null,
    sources: sourcesOf(yield* Nodes, sessionId),
    budget,
  });
  return sent.messages;
});

/**
 * A conversation of `answers.length + 1` user turns, recorded in memory the way runs record it.
 * The first answer used a tool.
 */
interface ConversationAt {
  readonly projectId: string;
  readonly sessionId: string;
}

export const conversation: {
  (
    at: ConversationAt,
    answers: readonly string[],
  ): (nodes: Nodes["Service"]) => ReturnType<typeof conversationBody>;
} & typeof conversationBody = EffectFunction.dual(3, conversationBody);

function conversationBody(nodes: Nodes["Service"], at: ConversationAt, answers: readonly string[]) {
  return Effect.gen(function* () {
    const toolOutput = "테스트 결과 ".repeat(200);
    const usedTool = Effect.andThen(
      nodes.append({
        ...at,
        kind: "tool_call",
        text: 'run_shell {"command":"pnpm test"}',
        detail: { toolName: "run_shell", toolCallId: "old-1" },
      }),
      nodes.append({
        ...at,
        kind: "tool_result",
        text: toolOutput,
        detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
      }),
    );
    const toolMessages: StoredMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "old-1",
            type: "function",
            function: { name: "run_shell", arguments: '{"command":"pnpm test"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "old-1", content: toolOutput },
    ];
    const turns = yield* Effect.forEach(
      answers,
      Effect.fnUntraced(function* (answer, index) {
        const question = `질문 ${index + 1}`;
        const userNode = yield* nodes.append({ ...at, kind: "user", text: question });
        const toolResult = yield* Effect.when(usedTool, Effect.succeed(index === 0));
        yield* nodes.append({ ...at, kind: "assistant", text: answer });
        const messages: StoredMessage[] = [
          { role: "user", content: question },
          ...(Option.isSome(toolResult) ? toolMessages : []),
          { role: "assistant", content: answer },
        ];
        return { userNode, toolResult, messages };
      }),
    );
    const last = `질문 ${answers.length + 1}`;
    const lastNode = yield* nodes.append({ ...at, kind: "user", text: last });
    const userNodes: Node[] = [...turns.map((turn) => turn.userNode), lastNode];
    const messages: StoredMessage[] = [
      ...turns.flatMap((turn) => turn.messages),
      { role: "user", content: last },
    ];
    const toolResult = Option.getOrThrow(Option.firstSomeOf(turns.map((turn) => turn.toolResult)));
    return { userNodes, messages, toolOutput, toolResult };
  });
}
