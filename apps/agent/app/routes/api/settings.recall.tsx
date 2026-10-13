import { Effect, Result, Schema } from "effect";
import { GlobalConfig } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.recall";

const RecallAction = Schema.Struct({
  crossProjectRecall: Schema.optional(Schema.Boolean),
  externalAgentMemory: Schema.optional(Schema.Boolean),
});

const settingsFailed = () => Response.json({ error: "settings_failed" }, { status: 500 });

const view = (settings: { crossProjectRecall?: boolean; externalAgentMemory?: boolean }) =>
  Response.json({
    crossProjectRecall: settings.crossProjectRecall === true,
    externalAgentMemory: settings.externalAgentMemory === true,
  });

/** GET /api/settings/recall: which memory a run may reach beyond its own project. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(
    Effect.flatMap(GlobalConfig, (config) => config.read).pipe(
      Effect.map(view),
      Effect.catchTag("GlobalConfigFailed", () => Effect.succeed(settingsFailed())),
    ),
  );
}

/**
 * POST /api/settings/recall { crossProjectRecall?, externalAgentMemory? }: search other projects'
 * memory too; send matching memory to external agents in direct conversations. Both start off.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, RecallAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_recall_settings" }, { status: 400 });
      return view(yield* (yield* GlobalConfig).update(body.success));
    }).pipe(Effect.catchTag("GlobalConfigFailed", () => Effect.succeed(settingsFailed()))),
  );
}
