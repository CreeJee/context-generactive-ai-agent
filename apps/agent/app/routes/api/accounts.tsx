import { isTruthy } from "../../truthy.ts";
import { Effect, Result, Schema } from "effect";
import {
  Database,
  SubscriptionAccountProvider,
  importLegacyOAuthProfile,
  removeOAuthProfile,
  renameOAuthProfile,
  selectOAuthProfile,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { accountLoginManager } from "~/.server/oauth-accounts";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/accounts";

const Action = Schema.Struct({
  intent: Schema.Literals(["add", "cancel", "select", "remove", "rename"]),
  provider: SubscriptionAccountProvider,
  label: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
});
const reply = <A,>(value: A, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const provider = new URL(request.url).searchParams.get("provider");
      if (!Schema.is(SubscriptionAccountProvider)(provider))
        return reply({ error: "invalid_provider" }, 400);
      return yield* Effect.gen(function* () {
        const { sqlite } = yield* Database;
        // Preserve existing auth even if OS keychain import fails. Subsequent requests retry.
        yield* Effect.promise(() =>
          importLegacyOAuthProfile({ sqlite: sqlite, provider: provider }).catch(() => null),
        );
        return reply(accountLoginManager(sqlite).profiles(provider));
      }).pipe(
        Effect.catchCause(() => Effect.succeed(reply({ error: "account_list_unavailable" }, 503))),
      );
    }),
  );
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const decoded = yield* Effect.tryPromise(() => readJson(request, Action));
      if (Result.isFailure(decoded)) return reply({ error: "invalid_account_action" }, 400);
      const { intent, provider, label, accountId } = decoded.success;
      if (
        (intent === "add" || intent === "rename") &&
        (!isTruthy(label?.trim()) || label.length > 80)
      )
        return reply({ error: "invalid_account_label" }, 400);
      if (
        (intent === "select" || intent === "remove" || intent === "rename") &&
        (!isTruthy(accountId) || accountId.length > 128)
      )
        return reply({ error: "invalid_account_id" }, 400);
      return yield* Effect.gen(function* () {
        const { sqlite } = yield* Database;
        const manager = accountLoginManager(sqlite);
        if (intent === "add")
          return reply(yield* Effect.tryPromise(() => manager.start(provider, label!)));
        if (intent === "cancel")
          return reply(yield* Effect.tryPromise(() => manager.cancel(provider)));
        if (intent === "remove")
          yield* Effect.tryPromise(() =>
            removeOAuthProfile({ sqlite: sqlite, provider: provider, id: accountId! }),
          );
        else if (intent === "rename") renameOAuthProfile(sqlite, provider, accountId!, label!);
        else
          yield* Effect.tryPromise(() =>
            selectOAuthProfile({ sqlite: sqlite, provider: provider, id: accountId! }),
          );
        return reply(manager.profiles(provider));
      }).pipe(
        // Never expose keychain/native OAuth errors or tokens to the browser.
        Effect.catchCause(() => Effect.succeed(reply({ error: "account_action_failed" }, 409))),
      );
    }),
  );
}
