import { Effect, Either, Schema } from "effect";
import { AppEvents, PermissionMode, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project._index";

const ProjectSettings = Schema.Struct({
  crossRecallExcluded: Schema.optional(Schema.Boolean),
  permissionMode: Schema.optional(PermissionMode),
  hidden: Schema.optional(Schema.Boolean),
});

/**
 * POST /api/projects/:project { crossRecallExcluded?, permissionMode?, hidden? }
 * - crossRecallExcluded: this project's memory is not searched from other projects (PRD R08).
 * - permissionMode: `ask` asks for every shell or outside write; `auto` lets a classifier decide.
 * - hidden: take it out of the sidebar. Its sessions, memory and search are untouched, and adding
 *   the same folder again brings it back.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, ProjectSettings);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_settings" }, { status: 400 });
  const { crossRecallExcluded, permissionMode, hidden } = body.right;

  const response = Effect.gen(function* () {
    const projects = yield* Projects;
    let project = yield* projects.get(params.project);
    if (crossRecallExcluded !== undefined)
      project = yield* projects.setCrossRecallExcluded(project.id, crossRecallExcluded);
    if (permissionMode !== undefined)
      project = yield* projects.setPermissionMode(project.id, permissionMode);
    if (hidden !== undefined) project = yield* projects.setHidden(project.id, hidden);
    (yield* AppEvents).publishGlobal("projects");
    return Response.json(project);
  }).pipe(
    Effect.catchTag("ProjectNotFound", () =>
      Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 })),
    ),
  );
  return agent.runPromise(response);
}
