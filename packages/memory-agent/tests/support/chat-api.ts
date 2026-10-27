import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { AgentChat } from "../../src/agent/chat.ts";
import { ChatApi, SameSite } from "../../src/api/chat-api.ts";
import { ChatApiHandlers } from "../../src/api/chat-api-live.ts";
import { TestEnv } from "./test-env.ts";

// The app checks the request's Origin; these requests come from the test itself.
const sameSite = Layer.succeed(SameSite, (httpEffect) => httpEffect);

/** A typed client of the chat API, answered in-process by the test's agent. */
export const chatApi = Effect.gen(function* () {
  const agent = yield* Effect.flatMap(TestEnv, (env) => env.use(AgentChat));
  const handlers = yield* Layer.build(
    ChatApiHandlers.pipe(
      Layer.provide(Layer.succeed(AgentChat, agent)),
      Layer.provideMerge(sameSite),
      Layer.merge(HttpServer.layerServices),
    ),
  );
  return (yield* HttpApiTest.groups(ChatApi, ["chat"]).pipe(Effect.provideContext(handlers))).chat;
});
