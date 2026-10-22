import { Effect, Match, Option, Result, Schema } from "effect";
import {
  GoalOrder,
  KanbanConcurrency,
  KanbanSettings,
  ProjectScheduler,
  Projects,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/settings.kanban";

/** A user value, or null to go back to the machine default; or a project's place in the tree. */
const KanbanCommand = Schema.TaggedUnion({
  SetConcurrency: { concurrency: Schema.NullOr(KanbanConcurrency) },
  /** The project goes in front of `before`, or last. */
  MoveProject: { projectId: Schema.String, before: Schema.NullOr(Schema.String) },
});

const settings = Effect.gen(function* () {
  const concurrency = yield* (yield* KanbanSettings).concurrency;
  const projectOrder = yield* (yield* GoalOrder).projects;
  return Response.json({
    configured: Option.getOrNull(concurrency.configured),
    effective: concurrency.effective,
    projectOrder,
  });
});

/**
 * GET /api/settings/kanban: how many kanban cards run at once across every Goal, and the order
 * of projects in the priority tree.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(settings.pipe(answerKanbanFailures));
}

/**
 * POST /api/settings/kanban { _tag: "SetConcurrency", concurrency }: 1-32 cards at once, or null
 * for the machine default. The card queue applies it at once; running cards are not stopped.
 * { _tag: "MoveProject", projectId, before } puts the project in front of `before` (or last) and
 * every board looks again.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, KanbanCommand));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_kanban_settings" }, { status: 400 });
      yield* Match.valueTags(body.success, {
        SetConcurrency: ({ concurrency }) =>
          Effect.flatMap(KanbanSettings, (kanban) =>
            concurrency === null ? kanban.resetConcurrency : kanban.setConcurrency(concurrency),
          ),
        MoveProject: ({ projectId, before }) =>
          Effect.gen(function* () {
            const projects = yield* Projects;
            yield* projects.get(projectId);
            if (before !== null) yield* projects.get(before);
            yield* (yield* ProjectScheduler).moveProject(projectId, before);
          }),
      });
      return yield* settings;
    }).pipe(answerKanbanFailures),
  );
}
