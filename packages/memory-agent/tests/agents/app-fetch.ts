import { Effect, FiberSet, Schema } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { Projects } from "../../src/projects/projects.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { sessionHolderHeader } from "../../src/sessions/lease-state.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { sdk } from "./agent-env.ts";

const SessionRequest = Schema.Struct({
  projectId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
});
const LeaseRequest = Schema.Struct({
  holder: Schema.NonEmptyString,
  action: Schema.Literals(["claim", "release"]),
});
const ApprovalRequest = Schema.Struct({ approved: Schema.Boolean });

const route = Effect.fnUntraced(function* (request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const holder = request.headers.get(sessionHolderHeader);
  const body = sdk(() => request.text()).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text || "{}"),
    ),
  );
  const chat = yield* AgentChat;

  if (path === "/api/auth") {
    const registry = yield* ProviderRegistry;
    const requested = url.searchParams.get("provider");
    const provider = registry.providers.find((candidate) => candidate === requested);
    const configured = yield* registry.get(provider ?? registry.providers[0]!);
    const state = yield* configured.auth.status;
    return Response.json(
      state.status === "pending"
        ? { provider: state.provider, status: state.status, authUrl: state.authorizationUrl }
        : state,
    );
  }
  if (path === "/api/projects") return Response.json(yield* (yield* Projects).list);
  if (path === "/api/sessions" && request.method === "POST") {
    const { projectId, title } = yield* Schema.decodeUnknownEffect(SessionRequest)(yield* body);
    return Response.json(yield* (yield* Sessions).create(projectId, title), { status: 201 });
  }
  if (path === "/api/chat") {
    const sessionId = url.searchParams.get("session") ?? "";
    return request.method === "POST"
      ? yield* chat.handle(request, sessionId)
      : yield* chat.hydrate(request, sessionId);
  }
  const session = /^\/api\/sessions\/([^/]+)(?:\/(lease|cancel|approvals)(?:\/([^/]+))?)?$/.exec(
    path,
  );
  if (session === null) return Response.json({ error: "not_found" }, { status: 404 });
  const [, sessionId, action, approvalId] = session;
  switch (action) {
    case undefined:
      return yield* chat.status(sessionId!, url.searchParams.get("holder"));
    case "lease": {
      const lease = yield* Schema.decodeUnknownEffect(LeaseRequest)(yield* body);
      return yield* chat.lease(sessionId!, lease.holder, lease.action);
    }
    case "cancel":
      return yield* chat.cancel(sessionId!, holder);
    case "approvals": {
      if (approvalId === undefined) return yield* chat.approvals(sessionId!);
      const { approved } = yield* Schema.decodeUnknownEffect(ApprovalRequest)(yield* body);
      return yield* chat.answerApproval(sessionId!, holder, approvalId, approved);
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
    AgentChat | Projects | ProviderRegistry | Sessions
  >();
  const fetcher: typeof fetch = (input, init) => run(route(new Request(input, init)));
  return fetcher;
});
