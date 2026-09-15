import { Effect, Either, Schema } from "effect";
import { ExternalAgents, Projects, Sessions } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions._index";

const CreateSession = Schema.Struct({
  projectId: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  /** Talk directly to this trusted external ACP agent instead of the app's model. */
  agent: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});

/** GET /api/sessions?project=<projectId> — sessions of a project, newest first. */
export async function loader({ request }: Route.LoaderArgs) {
  const projectId = new URL(request.url).searchParams.get("project");
  if (!projectId) return Response.json({ error: "project_required" }, { status: 400 });
  return Response.json(
    await agent.runPromise(Effect.flatMap(Sessions, (sessions) => sessions.list(projectId))),
  );
}

/**
 * POST /api/sessions { projectId, title?, agent? } — starts a new conversation in a project, with
 * the app's model or directly with a trusted external agent.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, CreateSession);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_session" }, { status: 400 });

  const { projectId, title, agent: external } = body.right;
  const response = Effect.gen(function* () {
    if (external) {
      const project = yield* (yield* Projects).get(projectId);
      if (!(yield* ExternalAgents).available(project).includes(external))
        return Response.json({ error: "external_agent_unavailable" }, { status: 409 });
    }
    const session = yield* (yield* Sessions).create(projectId, title ?? null, external ?? null);
    return Response.json(session, { status: 201 });
  }).pipe(
    Effect.catchTag("ProjectNotFound", () =>
      Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 })),
    ),
  );
  return agent.runPromise(response);
}
