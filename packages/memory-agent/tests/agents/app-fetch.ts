import { Effect, FiberSet, Layer, Schema, Struct } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { AuthConnectionState } from "../../src/providers/contracts.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import { appRefusalStatus } from "../../src/api/app-api.ts";
import { LeaseRequest } from "../../src/api/app-api/sessions.ts";
import { ChatApi, SameSite } from "../../src/api/chat-api.ts";
import { BtwApiHandlers, ChatApiHandlers } from "../../src/api/chat-api-live.ts";
import { BtwChat } from "../../src/btw/chat.ts";
import { Projects } from "../../src/projects/projects.ts";
import { ActiveProvider } from "../../src/providers/active-provider.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { sessionHolderHeader } from "../../src/sessions/lease-state.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { sdk } from "./agent-env.ts";

const SessionRequest = Schema.Struct({
  projectId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
});
const ApprovalRequest = Schema.Struct({ approved: Schema.Boolean });

/** The chat API's paths: a session's runs, a run's events and the session's messages. */
const chatApiPath = /^\/api\/sessions\/[^/]+\/(?:runs|messages)(?:\/|$)/;

// The app checks the request's Origin; these requests come from the bridge itself.
const sameSite = Layer.succeed(SameSite, (httpEffect) => httpEffect);

/** The chat API's web handler on the open agent, as the app's routes serve it. */
const chatApiHandler = Effect.gen(function* () {
  const agent = yield* Effect.context<AgentChat | BtwChat>();
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ChatApi).pipe(
          Layer.provide(Layer.merge(ChatApiHandlers, BtwApiHandlers)),
          Layer.provide(sameSite),
          Layer.provide(Layer.succeedContext(agent)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  );
});

/**
 * An `AgentChat` answer as the app API's handler gives it: the value, or the refusal with its
 * status. Any other failure fails the request.
 */
const answered = <A, R>(
  effect: Effect.Effect<A, { readonly error: string } | { readonly _tag: string }, R>,
) =>
  Effect.map(effect, (value) => Response.json(value)).pipe(
    Effect.catch((failure) =>
      "error" in failure
        ? Effect.succeed(Response.json(failure, { status: appRefusalStatus(failure) }))
        : Effect.die(failure),
    ),
  );

const route = Effect.fnUntraced(function* (
  chatApi: (request: Request) => Promise<Response>,
  request: Request,
) {
  const url = new URL(request.url);
  const path = url.pathname;
  const holder = request.headers.get(sessionHolderHeader);
  const body = sdk(() => request.text()).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text || "{}"),
    ),
  );
  if (chatApiPath.test(path)) return yield* sdk(() => chatApi(request));
  const chat = yield* AgentChat;

  if (path === "/api/auth") {
    const registry = yield* ProviderRegistry;
    const requested = url.searchParams.get("provider");
    // Without `provider` the app answers for its current provider, as the bridge asks.
    const provider =
      registry.providers.find((candidate) => candidate === requested) ??
      (yield* (yield* ActiveProvider).provider);
    const configured = yield* registry.get(provider);
    const state = yield* configured.auth.status;
    return Response.json(
      AuthConnectionState.$is("pending")(state)
        ? { ...Struct.omit(state, ["authorizationUrl"]), authUrl: state.authorizationUrl }
        : state,
    );
  }
  if (path === "/api/projects") return Response.json(yield* (yield* Projects).list);
  if (path === "/api/sessions" && request.method === "POST") {
    const { projectId, title } = yield* Schema.decodeUnknownEffect(SessionRequest)(yield* body);
    return Response.json(yield* (yield* Sessions).create(projectId, title), { status: 201 });
  }
  const session = /^\/api\/sessions\/([^/]+)(?:\/(lease|cancel|approvals)(?:\/([^/]+))?)?$/.exec(
    path,
  );
  if (session === null) return Response.json({ error: "not_found" }, { status: 404 });
  const [, sessionId, action, approvalId] = session;
  switch (action) {
    case undefined:
      return yield* answered(chat.status(sessionId!, url.searchParams.get("holder")));
    case "lease": {
      const lease = yield* Schema.decodeUnknownEffect(LeaseRequest)(yield* body);
      return yield* answered(chat.lease(sessionId!, lease.holder, lease.action));
    }
    case "cancel":
      return yield* answered(chat.cancel(sessionId!, holder));
    case "approvals": {
      if (approvalId === undefined) return yield* answered(chat.approvals(sessionId!));
      const { approved } = yield* Schema.decodeUnknownEffect(ApprovalRequest)(yield* body);
      return yield* answered(chat.answerApproval(sessionId!, holder, approvalId, approved));
    }
    default:
      return Response.json({ error: "not_found" }, { status: 404 });
  }
});

/**
 * The app's API routes the ACP bridge calls, served in-process from the open agent, so bridge
 * tests exercise the real handlers without starting the web app. Requests run in fibers owned by
 * the calling test.
 */
export const appFetch = Effect.gen(function* () {
  const run = yield* FiberSet.makeRuntimePromise<
    ActiveProvider | AgentChat | Projects | ProviderRegistry | Sessions
  >();
  const { handler } = yield* chatApiHandler;
  const fetcher: typeof fetch = (input, init) => run(route(handler, new Request(input, init)));
  return fetcher;
});
