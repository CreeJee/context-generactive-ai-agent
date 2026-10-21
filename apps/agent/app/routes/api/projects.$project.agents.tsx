import { Effect, Match, Result, Schema } from "effect";
import { AgentScope, ExternalAgents, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project.agents";

const AgentChange = Schema.TaggedUnion({
  trust: { scope: AgentScope, name: Schema.NonEmptyString, trusted: Schema.Boolean },
  reconnect: { name: Schema.NonEmptyString },
});

const projectNotFound = () =>
  Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 }));

/**
 * GET /api/projects/:project/agents: external ACP agents from `<storage>/agents.json` and
 * `<project>/.agents/agents.json`, with trust and connection state. Environment values are hidden.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
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
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, AgentChange));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_agent_change" }, { status: 400 });
      const change = body.success;
      return yield* Effect.gen(function* () {
        const project = yield* (yield* Projects).get(params.project);
        const agents = yield* ExternalAgents;
        return Response.json(
          yield* Match.valueTags(change, {
            trust: ({ scope, name, trusted }) => agents.setTrusted(project, scope, name, trusted),
            reconnect: ({ name }) => agents.reconnect(project, name),
          }),
        );
      }).pipe(Effect.catchTag("ProjectNotFound", projectNotFound));
    }),
  );
}
