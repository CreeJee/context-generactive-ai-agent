import { type Context, Duration, Effect, Layer } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { type AgentChat, BtwApiHandlers, type BtwChat, ChatApiHandlers } from "memory-agent";
import { AppApi, NoStore } from "memory-agent/app-api";
import { ChatApi, SameSite } from "memory-agent/chat-api";
import { agent } from "./agent.ts";
import { BtwThreadsApiHandlers } from "./api/btw.ts";
import { EventsApiHandlers } from "./api/events.ts";
import { MediaApiHandlers } from "./api/media.ts";
import { ProjectsApiHandlers } from "./api/projects.ts";
import { ReportsApiHandlers } from "./api/reports.ts";
import { AccountsApiHandlers, AuthApiHandlers, ModelsApiHandlers } from "./api/providers.ts";
import { SessionsApiHandlers } from "./api/sessions.ts";
import { SettingsApiHandlers } from "./api/settings.ts";
import { TraceApiHandlers } from "./api/trace.ts";
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

/** Every answer of a `NoStore` group carries `Cache-Control: no-store`, refusals included. */
const NoStoreLive = Layer.succeed(NoStore, (httpEffect) =>
  HttpEffect.withPreResponseHandler(httpEffect, (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "Cache-Control", "no-store")),
  ),
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

/** The app API's routes (`memory-agent/app-api`), answered by the agent's services. */
const appApiRoutes = HttpApiBuilder.layer(AppApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      SettingsApiHandlers,
      ProjectsApiHandlers,
      AuthApiHandlers,
      AccountsApiHandlers,
      ModelsApiHandlers,
      SessionsApiHandlers,
      TraceApiHandlers,
      BtwThreadsApiHandlers,
      ReportsApiHandlers,
      MediaApiHandlers,
      EventsApiHandlers,
    ),
  ),
  Layer.provide(Layer.merge(SameSiteLive, NoStoreLive)),
  Layer.provide(Layer.effectContext(agent.contextEffect)),
  Layer.provide(HttpServer.layerServices),
);

/** Every API answer says how long its handler took (`Server-Timing`). */
const serverTiming = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(Effect.timed(httpEffect), ([took, response]) =>
      HttpServerResponse.setHeader(
        response,
        "Server-Timing",
        `handler;dur=${Duration.toMillis(took).toFixed(3)}`,
      ),
    ),
  { global: true },
);

// Native CLI boundary: the stable dev backend is bundled with Vite's DEV flag off.
const developmentTiming = import.meta.env.DEV || process.argv.includes("--dev-backend");

let built: { readonly handler: (request: Request) => Promise<Response> } | null = null;

/**
 * Answers a request to the chat API (`memory-agent/chat-api`) or the app API
 * (`memory-agent/app-api`). The handler is built on the first request, because the server
 * configures the agent runtime after this module loads.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const serveApi = (request: Request) =>
  (built ??= HttpRouter.toWebHandler(
    Layer.mergeAll(
      chatApiRoutes(agent.contextEffect),
      appApiRoutes,
      developmentTiming ? serverTiming : Layer.empty,
    ),
    { disableLogger: true },
  )).handler(request);
