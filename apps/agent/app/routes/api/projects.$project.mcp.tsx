import { Effect, Match, Result, Schema } from "effect";
import { McpScope, McpServers, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project.mcp";

const McpChange = Schema.TaggedUnion({
  trust: { scope: McpScope, name: Schema.NonEmptyString, trusted: Schema.Boolean },
  login: { scope: McpScope, name: Schema.NonEmptyString },
  cancelLogin: { scope: McpScope, name: Schema.NonEmptyString },
  logout: { scope: McpScope, name: Schema.NonEmptyString },
});

const projectNotFound = () =>
  Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 }));

/**
 * GET /api/projects/:project/mcp: MCP servers from `<storage>/mcp.json` and `<project>/.mcp.json`,
 * with whether each is trusted and running. Environment and header values are never included.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).get(params.project);
      return Response.json(yield* (yield* McpServers).overview(project));
    }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
  );
}

/**
 * POST /api/projects/:project/mcp (R18)
 * - `trust` { scope, name, trusted }: starts that exact configuration; it does not approve any
 *   tool call. Distrusting also forgets the server's OAuth login.
 * - `login` { scope, name }: starts an OAuth login; the answer shows where to log in.
 * - `cancelLogin` / `logout` { scope, name }: stops that login, or forgets the stored one.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, McpChange));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_mcp_change" }, { status: 400 });
      const change = body.success;
      return yield* Effect.gen(function* () {
        const project = yield* (yield* Projects).get(params.project);
        const servers = yield* McpServers;
        return Response.json(
          yield* Match.valueTags(change, {
            trust: ({ scope, name, trusted }) => servers.setTrusted(project, scope, name, trusted),
            login: ({ scope, name }) => servers.login(project, scope, name),
            cancelLogin: ({ scope, name }) => servers.cancelLogin(project, scope, name),
            logout: ({ scope, name }) => servers.logout(project, scope, name),
          }),
        );
      }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound));
    }),
  );
}
