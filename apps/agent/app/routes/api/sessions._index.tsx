import { Effect, Either, Schema } from "effect";
import { Sessions } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions._index";

const CreateSession = Schema.Struct({
  projectId: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

/** GET /api/sessions?project=<projectId> — sessions of a project, newest first. */
export async function loader({ request }: Route.LoaderArgs) {
  const projectId = new URL(request.url).searchParams.get("project");
  if (!projectId) return Response.json({ error: "project_required" }, { status: 400 });
  return Response.json(
    await agent.runPromise(Effect.flatMap(Sessions, (sessions) => sessions.list(projectId))),
  );
}

/** POST /api/sessions { projectId, title? } — starts a new conversation in a project. */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, CreateSession);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_session" }, { status: 400 });

  const response = Effect.flatMap(Sessions, (sessions) =>
    sessions.create(body.right.projectId, body.right.title ?? null),
  ).pipe(
    Effect.map((session) => Response.json(session, { status: 201 })),
    Effect.catchTag("ProjectNotFound", () =>
      Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 })),
    ),
  );
  return agent.runPromise(response);
}
