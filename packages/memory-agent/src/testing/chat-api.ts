import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { ChatApi, SameSite } from "../api/chat-api.ts";
import { ChatApiHandlers } from "../api/chat-api-live.ts";

// The app checks the request's Origin; these requests come from the caller itself.
const sameSite = Layer.succeed(SameSite, (httpEffect) => httpEffect);

/** A typed client of the chat API, answered in-process by the agent in context. */
export const inProcessChatApi = Effect.gen(function* () {
  const handlers = yield* Layer.build(
    ChatApiHandlers.pipe(Layer.provideMerge(sameSite), Layer.merge(HttpServer.layerServices)),
  );
  return (yield* HttpApiTest.groups(ChatApi, ["chat"]).pipe(Effect.provideContext(handlers))).chat;
});
