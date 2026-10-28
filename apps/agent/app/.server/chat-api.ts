import { type Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { type AgentChat, BtwApiHandlers, type BtwChat, ChatApiHandlers } from "memory-agent";
import { ChatApi, SameSite } from "memory-agent/chat-api";
import { agent } from "./agent.ts";
import { crossSiteRefusal } from "./http.ts";

/** The page's routes refuse another site's change with `rejectCrossSite`; the API with this. */
const SameSiteLive = Layer.succeed(SameSite, (httpEffect) =>
  Effect.gen(function* () {
    // The web handler's request is the Request the route received.
    const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest).pipe(
      Effect.orDie,
    );
    const refusal = crossSiteRefusal(request);
    return refusal === null ? yield* httpEffect : yield* Effect.fail({ error: refusal });
  }),
);

/** The chat API's routes, answered by the agent whose services `services` gives. */
export const chatApiRoutes = <E>(
  services: Effect.Effect<Context.Context<AgentChat | BtwChat>, E>,
) =>
  HttpApiBuilder.layer(ChatApi).pipe(
    Layer.provide(Layer.merge(ChatApiHandlers, BtwApiHandlers)),
    Layer.provide(SameSiteLive),
    Layer.provide(Layer.effectContext(services)),
    Layer.provide(HttpServer.layerServices),
  );

let built: { readonly handler: (request: Request) => Promise<Response> } | null = null;

/**
 * Answers a request to the chat API (`memory-agent/chat-api`). The handler is built on the first
 * request, because the server configures the agent runtime after this module loads.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const serveChatApi = (request: Request) =>
  (built ??= HttpRouter.toWebHandler(chatApiRoutes(agent.contextEffect), {
    disableLogger: true,
  })).handler(request);
