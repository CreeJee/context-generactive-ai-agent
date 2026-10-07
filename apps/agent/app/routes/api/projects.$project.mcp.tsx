import { Effect, Result, Schema } from "effect";
import { McpScope, McpServers, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project.mcp";

const TrustChange = Schema.Struct({
  scope: McpScope,
  name: Schema.NonEmptyString,
  trusted: Schema.Boolean,
});

const projectNotFound = () =>
  Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 }));

/**
 * GET /api/projects/:project/mcp: MCP servers from `<storage>/mcp.json` and `<project>/.mcp.json`,
 * with whether each is trusted and running. Environment and header values are never included.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).get(params.project);
      return Response.json(yield* (yield* McpServers).overview(project));
    }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
  );
}

/**
 * POST /api/projects/:project/mcp { scope, name, trusted } (R18)
 * Trusting starts that exact configuration; it does not approve any tool call.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected !== null) return rejected;
  const body = await readJson(request, TrustChange);
  if (Result.isFailure(body))
    return Response.json({ error: "invalid_mcp_change" }, { status: 400 });
  const { scope, name, trusted } = body.success;
  return agent.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).get(params.project);
      return Response.json(yield* (yield* McpServers).setTrusted(project, scope, name, trusted));
    }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
  );
}
