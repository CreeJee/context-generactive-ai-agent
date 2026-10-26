import { DateTime, Effect, Result, Schema } from "effect";
import { AppEvents, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects._index";

const AddProject = Schema.Struct({ root: Schema.NonEmptyString });

/** GET /api/projects — registered project roots; `?hidden=1` lists the archived ones instead. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  const hidden = new URL(request.url).searchParams.get("hidden") === "1";
  // Native CLI boundary: the stable dev backend is bundled with Vite's DEV flag off.
  const developmentTiming = import.meta.env.DEV || process.argv.includes("--dev-backend");
  const boundaryStarted = performance.now();
  return agent
    .runPromise(
      Effect.gen(function* () {
        const started = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
        const projects = yield* Projects;
        const serviceAt = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
        const result = hidden
          ? (yield* projects.listAll).filter((project) => project.hiddenAt !== null)
          : yield* projects.list;
        const finished = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
        return { result, serviceMs: serviceAt - started, queryMs: finished - serviceAt };
      }),
    )
    .then((measured) => {
      const result = Response.json(measured.result);
      if (developmentTiming)
        result.headers.set(
          "Server-Timing",
          `service;dur=${measured.serviceMs}, query;dur=${measured.queryMs}, runtime-boundary;dur=${(performance.now() - boundaryStarted).toFixed(3)}`,
        );
      return result;
    });
}

/**
 * POST /api/projects { root } — registers a directory. File and shell tools may later act inside
 * it, so the path is canonicalized and must not overlap the app's storage directory.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, AddProject));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_project" }, { status: 400 });

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
      return yield* response;
    }),
  );
}
