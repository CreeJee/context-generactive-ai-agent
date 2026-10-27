import { Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  CompatibleFetch,
  CompatibleKeyring,
  OpenAICompatibleSettings,
} from "../../src/providers/openai-compatible.ts";
import { runTurn, streamedText } from "../support/chat-client.ts";
import { freshSession, testAgent } from "../support/test-env.ts";

const ChatRequest = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.optional(
      Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
    ),
    messages: Schema.Array(Schema.Struct({ role: Schema.String })),
  }),
);
type ChatRequest = typeof ChatRequest.Type;

const sse = (...chunks: readonly object[]) =>
  new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
interface Delta {
  readonly role?: "assistant";
  readonly content?: string;
  readonly tool_calls?: readonly object[];
}
const chunk = (delta: Delta, finishReason: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 1,
  model: "manual",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

// The endpoint answers like vLLM: an announcement, then the tool call in the same turn; after the
// tool result it answers in text.
const requests: ChatRequest[] = [];
const endpoint: typeof fetch = (input, init) => {
  const sent = new Request(input, init);
  if (!sent.url.endsWith("/chat/completions"))
    return Promise.resolve(Response.json({ object: "list", data: [] }));
  const answer = (request: ChatRequest) => {
    requests.push(request);
    return request.messages.some((message) => message.role === "tool")
      ? sse(chunk({ role: "assistant", content: "done" }), chunk({}, "stop"))
      : sse(
          chunk({ role: "assistant", content: "기록을 먼저 확인하겠습니다." }),
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "find_memory", arguments: '{"query":"import"}' },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        );
  };
  return Effect.runPromise(
    Effect.tryPromise(() => sent.text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ChatRequest)),
      Effect.map(answer),
    ),
  );
};

testAgent({
  compatibleSettings: OpenAICompatibleSettings.layerWith(
    Layer.succeed(CompatibleKeyring, () => ({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    })),
    Layer.succeed(CompatibleFetch, endpoint),
  ),
})("compatible chat tools", (it) => {
  it.effect("runs a tool the model calls after text and continues the turn", () =>
    Effect.gen(function* () {
      const compatible = yield* OpenAICompatibleSettings;
      const account = (yield* compatible.create({ baseUrl: "http://localhost:8000/v1" }))
        .accounts[0]!;
      yield* compatible.saveModel(account.id, {
        id: "manual",
        contextWindow: 200_000,
        outputBudget: 512,
        toolCalling: true,
      });
      yield* compatible.services.models.select("manual");
      const sessionId = yield* freshSession;
      const events = yield* runTurn(sessionId, `${sessionId}-run`, "가져온다고 하고 멈췄는데?");

      expect(requests[0]?.tools?.map((tool) => tool.function.name)).toContain("find_memory");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.messages.map((message) => message.role)).toContain("tool");
      expect(streamedText(events)).toContain("done");
    }),
  );
});
