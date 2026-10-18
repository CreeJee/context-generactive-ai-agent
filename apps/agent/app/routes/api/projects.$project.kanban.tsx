import { Effect, Result, Schema } from "effect";
import { GoalSchedules, Projects, ProtectedBranches } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.$project.kanban";

const ProjectKanbanAction = Schema.Struct({ protectedBranches: ProtectedBranches });

const projectNotFound = () =>
  Effect.succeed(Response.json({ error: "project_not_found" }, { status: 404 }));
const settingsFailed = () =>
  Effect.succeed(Response.json({ error: "settings_failed" }, { status: 500 }));

/** GET /api/projects/:project/kanban — branches the project's Goals never merge into on their own. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Projects).get(params.project);
      const protectedBranches = yield* (yield* GoalSchedules).protectedBranches(params.project);
      return Response.json({ protectedBranches });
    }).pipe(
      Effect.catchTags({
        ProjectNotFound: projectNotFound,
        GoalScheduleStorageFailed: settingsFailed,
      }),
    ),
  );
}

/**
 * POST /api/projects/:project/kanban { protectedBranches }: a finished Goal whose target is one of
 * these asks a person (pull request or manual merge) instead of merging. An empty list protects none.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, ProjectKanbanAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_kanban_settings" }, { status: 400 });
      yield* (yield* Projects).get(params.project);
      const protectedBranches = yield* (yield* GoalSchedules).setProtectedBranches(
        params.project,
        body.success.protectedBranches,
      );
      return Response.json({ protectedBranches });
    }).pipe(
      Effect.catchTags({
        ProjectNotFound: projectNotFound,
        GoalScheduleStorageFailed: settingsFailed,
        SchemaError: () =>
          Effect.succeed(Response.json({ error: "invalid_kanban_settings" }, { status: 400 })),
      }),
    ),
  );
}
