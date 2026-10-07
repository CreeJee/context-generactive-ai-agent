import { isTruthy } from "../../src/truthy.ts";
import { Cause, Effect, Schema, type ManagedRuntime } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { Projects } from "../../src/projects/projects.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { sessionHolderHeader } from "../../src/sessions/lease-state.ts";
import { Sessions } from "../../src/sessions/sessions.ts";

type Runtime = ManagedRuntime.ManagedRuntime<
  AgentChat | Projects | ProviderRegistry | Sessions,
  unknown
>;
const SessionRequest = Schema.Struct({
  projectId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
});
const LeaseRequest = Schema.Struct({
  holder: Schema.NonEmptyString,
  action: Schema.Literals(["claim", "release"]),
});
const ApprovalRequest = Schema.Struct({ approved: Schema.Boolean });

/**
 * The app's API routes the ACP bridge calls, served in-process from a test runtime, so bridge
 * tests exercise the real handlers without starting the web app.
 */
export function appFetch(runtime: Runtime): typeof fetch {
  // Chat execution belongs to the runtime's service Scope; this boundary dispatches API Effects.
  return (input, init) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const holder = request.headers.get(sessionHolderHeader);
        const body = Effect.tryPromise({
          try: () => request.text(),
          catch: (cause) => new Cause.UnknownError(cause),
        }).pipe(
          Effect.flatMap((text) =>
            Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text || "{}"),
          ),
        );
        const path = url.pathname;
        let match: RegExpExecArray | null;

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
          const { projectId, title } = yield* Schema.decodeUnknownEffect(SessionRequest)(
            yield* body,
          );
          return Response.json(yield* (yield* Sessions).create(projectId, title), { status: 201 });
        }
        if (path === "/api/chat") {
          const sessionId = url.searchParams.get("session") ?? "";
          const chat = yield* AgentChat;
          return request.method === "POST"
            ? yield* chat.handle(request, sessionId)
            : yield* chat.hydrate(request, sessionId);
        }
        if (isTruthy((match = /^\/api\/sessions\/([^/]+)$/.exec(path))))
          return yield* (yield* AgentChat).status(match[1]!, url.searchParams.get("holder"));
        if (isTruthy((match = /^\/api\/sessions\/([^/]+)\/lease$/.exec(path)))) {
          const { holder: leaseHolder, action } = yield* Schema.decodeUnknownEffect(LeaseRequest)(
            yield* body,
          );
          return yield* (yield* AgentChat).lease(match[1]!, leaseHolder, action);
        }
        if (isTruthy((match = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path))))
          return yield* (yield* AgentChat).cancel(match[1]!, holder);
        if (isTruthy((match = /^\/api\/sessions\/([^/]+)\/approvals$/.exec(path))))
          return yield* (yield* AgentChat).approvals(match[1]!);
        if (isTruthy((match = /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(path)))) {
          const { approved } = yield* Schema.decodeUnknownEffect(ApprovalRequest)(yield* body);
          return yield* (yield* AgentChat).answerApproval(match[1]!, holder, match[2]!, approved);
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }),
    );
}
