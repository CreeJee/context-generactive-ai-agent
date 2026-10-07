import { isTruthy } from "../truthy.ts";
import { AgentChat } from "memory-agent";
import { Effect } from "effect";
import { rejectCrossSite } from "~/.server/http";

interface ChatRuntime {
  readonly runPromise: <A, E>(program: Effect.Effect<A, E, AgentChat>) => Promise<A>;
}
export function makeChatHandlers(agent: ChatRuntime) {
  const sessionOf = (request: Request) => new URL(request.url).searchParams.get("session");

  /**
   * GET /api/chat?session=<sessionId>&threadId=<sessionId> — what `useChat({ persistence: true })`
   * hydrates from on mount: the stored transcript, a run still generating, and pending approvals.
   */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loader({ request }: { request: Request }) {
    return agent.runPromise(
      Effect.gen(function* () {
        const sessionId = sessionOf(request);
        if (!isTruthy(sessionId))
          return Response.json({ error: "session_required" }, { status: 400 });
        return yield* (yield* AgentChat).hydrate(request, sessionId);
      }),
    );
  }

  /**
   * POST /api/chat?session=<sessionId> with an AG-UI RunAgentInput body (what TanStack's
   * `fetchServerSentEvents` sends). Streams the run as Server-Sent Events.
   */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function action({ request }: { request: Request }) {
    return agent.runPromise(
      Effect.gen(function* () {
        const rejected = rejectCrossSite(request);
        if (rejected !== null) return rejected;
        const sessionId = sessionOf(request);
        if (!isTruthy(sessionId))
          return Response.json({ error: "session_required" }, { status: 400 });
        return yield* (yield* AgentChat).handle(request, sessionId);
      }),
    );
  }

  return { action, loader };
}
