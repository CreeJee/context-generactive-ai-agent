import { chat, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";
import { Cause, Effect, Function as EffectFunction, Stream } from "effect";
import type { CompactionSources } from "../../src/agent/compaction.ts";
import type { Node, Nodes } from "../../src/memory/nodes.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";

export const call = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

export const drain = <A>(stream: AsyncIterable<A>) =>
  Stream.runDrain(Stream.fromAsyncIterable(stream, (cause) => new Cause.UnknownError(cause)));

export const noLimit = 1_000_000;

export const sourcesOf: {
  (sessionId: string): (nodes: Nodes["Service"]) => CompactionSources;
  (nodes: Nodes["Service"], sessionId: string): CompactionSources;
} = EffectFunction.dual(2, (nodes: Nodes["Service"], sessionId: string): CompactionSources => ({
  toolResultId: (toolCallId) => nodes.toolResultId(sessionId, toolCallId),
  nodeText: (id) => nodes.get(id)?.text ?? null,
}));

/** What the model is sent on the first call of a run over `messages`. */
export const firstSent = Effect.fnUntraced(function* (
  messages: readonly ModelMessage[],
  middleware: ChatMiddleware,
  threadId: string,
) {
  const adapter = new ScriptedTextAdapter([{ text: "네" }]);
  yield* drain(chat({ adapter, threadId, messages: [...messages], middleware: [middleware] }));
  return adapter.invocations[0]?.messages ?? [];
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
  const userNodes: Node[] = [];
  const messages: ModelMessage[] = [];
  const toolOutput = "테스트 결과 ".repeat(200);
  let toolResult: Node | null = null;
  answers.forEach((answer, index) => {
    const question = `질문 ${index + 1}`;
    userNodes.push(nodes.append({ ...at, kind: "user", text: question }));
    messages.push({ role: "user", content: question });
    if (index === 0) {
      nodes.append({
        ...at,
        kind: "tool_call",
        text: 'run_shell {"command":"pnpm test"}',
        detail: { toolName: "run_shell", toolCallId: "old-1" },
      });
      toolResult = nodes.append({
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
    nodes.append({ ...at, kind: "assistant", text: answer });
    messages.push({ role: "assistant", content: answer });
  });
  const last = `질문 ${answers.length + 1}`;
  userNodes.push(nodes.append({ ...at, kind: "user", text: last }));
  messages.push({ role: "user", content: last });
  return { userNodes, messages, toolOutput, toolResult: toolResult! };
}
