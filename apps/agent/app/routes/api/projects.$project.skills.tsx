import { Effect } from "effect";
import { Projects, Skills } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/projects.$project.skills";

/**
 * GET /api/projects/:project/skills: skills from `~/.agents/skills` and `<project>/.agents/skills`
 * that conversations in this project can use, and folders that could not be read as skills.
 */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).get(params.project);
      return Response.json((yield* Skills).catalog(project));
    }).pipe(
      Effect.catchTag("ProjectNotFound", () =>
        Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 })),
      ),
    ),
  );
}
