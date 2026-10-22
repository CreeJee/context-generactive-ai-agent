import { Effect, Match, Result, Schema } from "effect";
import {
  AppEvents,
  GoalOrder,
  GoalSchedules,
  Projects,
  ProjectScheduler,
  ProtectedBranches,
  Sessions,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/projects.$project.kanban";

/** The project's kanban settings a person changes: protected branches, or a Goal's place. */
const ProjectKanbanCommand = Schema.TaggedUnion({
  SetProtectedBranches: { protectedBranches: ProtectedBranches },
  /** The conversation's Goal goes in front of `before`, or last. */
  MoveGoal: { sessionId: Schema.String, before: Schema.NullOr(Schema.String) },
});

const settings = (projectId: string) =>
  Effect.gen(function* () {
    const goal = yield* GoalSchedules;
    const order = yield* GoalOrder;
    const protectedBranches = yield* goal.protectedBranches(projectId);
    const goalOrder = yield* order.goals(projectId);
    return Response.json({ protectedBranches, goalOrder });
  });

/**
 * GET /api/projects/:project/kanban — branches the project's Goals never merge into on their own,
 * and the order of the project's Goals (conversations with workflow state) in the priority tree.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Projects).get(params.project);
      return yield* settings(params.project);
    }).pipe(answerKanbanFailures),
  );
}

/**
 * POST /api/projects/:project/kanban { _tag: "SetProtectedBranches", protectedBranches }: a
 * finished Goal whose target is one of these asks a person (pull request or manual merge) instead
 * of merging; an empty list protects none. { _tag: "MoveGoal", sessionId, before } puts the
 * conversation's Goal in front of `before` (or last) and the project's boards look again.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, ProjectKanbanCommand));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_kanban_settings" }, { status: 400 });
      yield* (yield* Projects).get(params.project);
      yield* Match.valueTags(body.success, {
        SetProtectedBranches: ({ protectedBranches }) =>
          Effect.flatMap(GoalSchedules, (schedules) =>
            schedules.setProtectedBranches(params.project, protectedBranches),
          ),
        MoveGoal: ({ sessionId, before }) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* sessions.get(sessionId);
            if (before !== null) yield* sessions.get(before);
            yield* (yield* ProjectScheduler).moveGoal(params.project, sessionId, before);
            // The board list carries each Goal's place, so open boards read it again.
            (yield* AppEvents).publishProject(params.project, "sessions");
          }),
      });
      return yield* settings(params.project);
    }).pipe(answerKanbanFailures),
  );
}
