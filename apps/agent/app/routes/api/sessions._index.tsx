import { isTruthy } from "../../truthy.ts";
import { Effect, Result, Schema } from "effect";
import { AppEvents, ExternalAgents, Projects, Sessions } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions._index";

const CreateSession = Schema.Struct({
  projectId: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  /** Talk directly to this trusted external ACP agent instead of the app's model. */
  agent: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});

/**
 * GET /api/sessions?project=<projectId>[&archived=1] — sessions of a project, newest first; with
 * `archived=1`, only the archived ones.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const params = new URL(request.url).searchParams;
      const projectId = params.get("project");
      if (!isTruthy(projectId))
        return Response.json({ error: "project_required" }, { status: 400 });
      const archived = params.get("archived") === "1";
      return Response.json(
        yield* Effect.flatMap(Sessions, (sessions) => sessions.list(projectId, archived)),
      );
    }),
  );
}

/**
 * POST /api/sessions { projectId, title?, agent? } — starts a new conversation in a project, with
 * the app's model or directly with a trusted external agent.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, CreateSession));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_session" }, { status: 400 });

      const { projectId, title, agent: external } = body.success;
      const response = Effect.gen(function* () {
        if (isTruthy(external)) {
          const project = yield* (yield* Projects).get(projectId);
          if (!(yield* (yield* ExternalAgents).available(project)).includes(external))
            return Response.json({ error: "external_agent_unavailable" }, { status: 409 });
        }
        const session = yield* (yield* Sessions).create(projectId, title ?? null, external ?? null);
        (yield* AppEvents).publishProject(projectId, "sessions");
        return Response.json(session, { status: 201 });
      }).pipe(
        Effect.catchTag("ProjectNotFound", () =>
          Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 })),
        ),
      );
      return yield* response;
    }),
  );
}
