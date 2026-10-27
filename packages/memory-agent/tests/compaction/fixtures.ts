import { Cause, Effect, Function as EffectFunction } from "effect";
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
    const userNodes: Node[] = [];
    const messages: StoredMessage[] = [];
    const toolOutput = "테스트 결과 ".repeat(200);
    let toolResult: Node | null = null;
    for (const [index, answer] of answers.entries()) {
      const question = `질문 ${index + 1}`;
      userNodes.push(yield* nodes.append({ ...at, kind: "user", text: question }));
      messages.push({ role: "user", content: question });
      if (index === 0) {
        yield* nodes.append({
          ...at,
          kind: "tool_call",
          text: 'run_shell {"command":"pnpm test"}',
          detail: { toolName: "run_shell", toolCallId: "old-1" },
        });
        toolResult = yield* nodes.append({
          ...at,
          kind: "tool_result",
          text: toolOutput,
          detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
        });
        messages.push(
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
        );
      }
      yield* nodes.append({ ...at, kind: "assistant", text: answer });
      messages.push({ role: "assistant", content: answer });
    }
    const last = `질문 ${answers.length + 1}`;
    userNodes.push(yield* nodes.append({ ...at, kind: "user", text: last }));
    messages.push({ role: "user", content: last });
    return { userNodes, messages, toolOutput, toolResult: toolResult! };
  });
}
