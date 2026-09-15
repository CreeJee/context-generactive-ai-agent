import { Effect, Either, Schema } from "effect";
import { AgentScope, ExternalAgents, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project.agents";

const AgentChange = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("trust"),
    scope: AgentScope,
    name: Schema.NonEmptyString,
    trusted: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literal("reconnect"), name: Schema.NonEmptyString }),
);

const projectNotFound = () =>
  Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 }));

/**
 * GET /api/projects/:project/agents: external ACP agents from `<storage>/agents.json` and
 * `<project>/.agents/agents.json`, with trust and connection state. Environment values are hidden.
 */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).get(params.project);
      return Response.json(yield* (yield* ExternalAgents).overview(project));
    }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
  );
}

/**
 * POST /api/projects/:project/agents (R17)
 * - `trust` { scope, name, trusted }: allow (or stop) starting that exact configuration.
 * - `reconnect` { name }: after automatic reconnecting gave up, try again.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, AgentChange);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_agent_change" }, { status: 400 });
  const change = body.right;
  return agent.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).get(params.project);
      const agents = yield* ExternalAgents;
      switch (change.action) {
        case "trust":
          return Response.json(
            yield* agents.setTrusted(project, change.scope, change.name, change.trusted),
          );
        case "reconnect":
          return Response.json(yield* agents.reconnect(project, change.name));
      }
    }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
  );
}
