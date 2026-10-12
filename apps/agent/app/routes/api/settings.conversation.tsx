import { Effect, Result, Schema } from "effect";
import { SummaryStartPercent, TurnSummaries } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.conversation";

const ConversationAction = Schema.Struct({ summaryStartPercent: SummaryStartPercent });

const settingsFailed = () => Response.json({ error: "settings_failed" }, { status: 500 });

/** GET /api/settings/conversation: when long conversations start being summarized. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(
    Effect.flatMap(TurnSummaries, (summaries) => summaries.startPercent).pipe(
      Effect.map((summaryStartPercent) => Response.json({ summaryStartPercent })),
      Effect.catchTag("GlobalConfigFailed", () => Effect.succeed(settingsFailed())),
    ),
  );
}

/**
 * POST /api/settings/conversation { summaryStartPercent }: the share of the model's context window,
 * 0-50 percent, a conversation fills before its turns are summarized. Applies from the next run.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, ConversationAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_conversation_settings" }, { status: 400 });
      const summaryStartPercent = yield* (yield* TurnSummaries).setStartPercent(
        body.success.summaryStartPercent,
      );
      return Response.json({ summaryStartPercent });
    }).pipe(Effect.catchTag("GlobalConfigFailed", () => Effect.succeed(settingsFailed()))),
  );
}
