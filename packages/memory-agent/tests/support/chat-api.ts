import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { AgentChat } from "../../src/agent/chat.ts";
import { ChatApi, SameSite } from "../../src/api/chat-api.ts";
import { BtwApiHandlers } from "../../src/api/chat-api-live.ts";
import { BtwChat } from "../../src/btw/chat.ts";
import { inProcessChatApi } from "../../src/testing/chat-api.ts";
import { TestEnv } from "./test-env.ts";

// The app checks the request's Origin; these requests come from the test itself.
const sameSite = Layer.succeed(SameSite, (httpEffect) => httpEffect);

/** A typed client of the chat API, answered in-process by the test's agent. */
export const chatApi = Effect.flatMap(
  Effect.flatMap(TestEnv, (env) => env.use(AgentChat)),
  (agent) => Effect.provideService(inProcessChatApi, AgentChat, agent),
);

/** A typed client of the API's BTW threads, answered in-process by the test's agent. */
export const btwApi = Effect.gen(function* () {
  const btw = yield* Effect.flatMap(TestEnv, (env) => env.use(BtwChat));
  const handlers = yield* Layer.build(
    BtwApiHandlers.pipe(
      Layer.provide(Layer.succeed(BtwChat, btw)),
      Layer.provideMerge(sameSite),
      Layer.merge(HttpServer.layerServices),
    ),
  );
  return (yield* HttpApiTest.groups(ChatApi, ["btw"]).pipe(Effect.provideContext(handlers))).btw;
});
