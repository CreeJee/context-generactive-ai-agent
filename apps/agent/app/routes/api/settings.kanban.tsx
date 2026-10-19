import { Effect, Option, Result, Schema } from "effect";
import { KanbanConcurrency, KanbanSettings } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/settings.kanban";

/** A user value, or null to go back to the machine default. */
const KanbanAction = Schema.Struct({ concurrency: Schema.NullOr(KanbanConcurrency) });

const toJson = (setting: {
  readonly configured: Option.Option<number>;
  readonly effective: number;
}) =>
  Response.json({
    configured: Option.getOrNull(setting.configured),
    effective: setting.effective,
  });

/** GET /api/settings/kanban: how many kanban cards run at once across every Goal. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(
    Effect.flatMap(KanbanSettings, (settings) => settings.concurrency).pipe(
      Effect.map(toJson),
      answerKanbanFailures,
    ),
  );
}

/**
 * POST /api/settings/kanban { concurrency }: 1-32 cards at once, or null for the machine default.
 * The card queue applies it at once; running cards are not stopped.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, KanbanAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_kanban_settings" }, { status: 400 });
      const settings = yield* KanbanSettings;
      const concurrency = body.success.concurrency;
      return toJson(
        concurrency === null
          ? yield* settings.resetConcurrency
          : yield* settings.setConcurrency(concurrency),
      );
    }).pipe(answerKanbanFailures),
  );
}
