import { Effect, type ManagedRuntime } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { CodexAccount } from "../../src/codex/account.ts";
import { Projects } from "../../src/projects/projects.ts";
import { sessionHolderHeader } from "../../src/sessions/lease-state.ts";
import { Sessions } from "../../src/sessions/sessions.ts";

type Runtime = ManagedRuntime.ManagedRuntime<
  AgentChat | CodexAccount | Projects | Sessions,
  unknown
>;

/**
 * The app's API routes the ACP bridge calls, served in-process from a test runtime, so bridge
 * tests exercise the real handlers without starting the web app.
 */
export function appFetch(runtime: Runtime): typeof fetch {
  const run = <A, E>(effect: Effect.Effect<A, E, AgentChat | CodexAccount | Projects | Sessions>) =>
    runtime.runPromise(effect);
  const chat = <A>(use: (agent: Effect.Effect.Success<typeof AgentChat>) => Effect.Effect<A>) =>
    run(Effect.flatMap(AgentChat, use));

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const holder = request.headers.get(sessionHolderHeader);
    const body = async () => JSON.parse((await request.text()) || "{}");
    const path = url.pathname;
    let match: RegExpExecArray | null;

    if (path === "/api/auth")
      return Response.json(await run(Effect.flatMap(CodexAccount, (a) => a.status)));
    if (path === "/api/projects")
      return Response.json(await run(Effect.flatMap(Projects, (p) => p.list)));
    if (path === "/api/sessions" && request.method === "POST") {
      const { projectId, title } = await body();
      return Response.json(await run(Effect.flatMap(Sessions, (s) => s.create(projectId, title))), {
        status: 201,
      });
    }
    if (path === "/api/chat") {
      const sessionId = url.searchParams.get("session") ?? "";
      return request.method === "POST"
        ? chat((agent) => agent.handle(request, sessionId))
        : chat((agent) => agent.hydrate(request, sessionId));
    }
    if ((match = /^\/api\/sessions\/([^/]+)$/.exec(path)))
      return chat((agent) => agent.status(match![1]!, url.searchParams.get("holder")));
    if ((match = /^\/api\/sessions\/([^/]+)\/lease$/.exec(path))) {
      const { holder: leaseHolder, action } = await body();
      return chat((agent) => agent.lease(match![1]!, leaseHolder, action));
    }
    if ((match = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path)))
      return chat((agent) => agent.cancel(match![1]!, holder));
    if ((match = /^\/api\/sessions\/([^/]+)\/subagents$/.exec(path)))
      return chat((agent) => agent.subagents(match![1]!));
    if ((match = /^\/api\/sessions\/([^/]+)\/subagents\/approvals\/([^/]+)$/.exec(path))) {
      const { approved } = await body();
      return chat((agent) => agent.answerSubagent(match![1]!, holder, match![2]!, approved));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}
