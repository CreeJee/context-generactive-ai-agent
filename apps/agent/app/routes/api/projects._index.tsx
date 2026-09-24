import { Effect, Result, Schema } from "effect";
import { AppEvents, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects._index";

const AddProject = Schema.Struct({ root: Schema.NonEmptyString });

/** GET /api/projects — registered project roots. */
export async function loader() {
  return Response.json(
    await agent.runPromise(Effect.flatMap(Projects, (projects) => projects.list)),
  );
}

/**
 * POST /api/projects { root } — registers a directory. File and shell tools may later act inside
 * it, so the path is canonicalized and must not overlap the app's storage directory.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, AddProject);
  if (Result.isFailure(body)) return Response.json({ error: "invalid_project" }, { status: 400 });

  const response = Effect.gen(function* () {
    const project = yield* (yield* Projects).add(body.success.root);
    (yield* AppEvents).publishGlobal("projects");
    return Response.json(project, { status: 201 });
  }).pipe(
    Effect.catchTag("ProjectRootRejected", (error) =>
      Effect.succeed(
        Response.json({ error: "project_rejected", reason: error.reason }, { status: 422 }),
      ),
    ),
  );
  return agent.runPromise(response);
}
