import { Effect, Schema } from "effect";
import { SubscriptionAccountProvider, SubscriptionQuota } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/accounts.quota";

const reply = <A,>(value: A, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Per-account subscription quota status. Only verified, allowed routes may report numbers; every
 * other account says why its quota is unavailable. Local token counts are never substituted.
 */
// Promise boundary for React Router; the quota lookup runs in the agent runtime.
export function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const provider = new URL(request.url).searchParams.get("provider");
      if (!Schema.is(SubscriptionAccountProvider)(provider))
        return reply({ error: "invalid_provider" }, 400);
      const quota = yield* SubscriptionQuota;
      return reply(yield* quota.accounts(provider));
    }).pipe(
      Effect.catchTag("SubscriptionQuotaError", () =>
        Effect.succeed(reply({ error: "quota_status_unavailable" }, 503)),
      ),
    ),
  );
}
