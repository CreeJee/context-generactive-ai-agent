import { Effect, Either, Schema } from "effect";
import { Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project";

const ProjectSettings = Schema.Struct({ crossRecallExcluded: Schema.Boolean });

/**
 * POST /api/projects/:project { crossRecallExcluded } — when true, this project's memory is not
 * searched from other projects (PRD R08). Its own sessions still use it.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, ProjectSettings);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_settings" }, { status: 400 });

  const response = Effect.flatMap(Projects, (projects) =>
    projects.setCrossRecallExcluded(params.project, body.right.crossRecallExcluded),
  ).pipe(
    Effect.map((project) => Response.json(project)),
    Effect.catchTag("ProjectNotFound", () =>
      Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 })),
    ),
  );
  return agent.runPromise(response);
}
