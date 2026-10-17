import { isTruthy } from "../../truthy.ts";
import { Effect, Result, Schema } from "effect";
import {
  AppEvents,
  Database,
  SubscriptionAccountProvider,
  importLegacyOAuthProfile,
  removeOAuthProfile,
  renameOAuthProfile,
  selectOAuthProfile,
} from "memory-agent";
import { agent } from "~/.server/agent";
import {
  CompatibleAccountCommand,
  compatibleAccountAction,
  compatibleAccounts,
} from "~/.server/compatible-handlers";
import { accountLoginManager } from "~/.server/oauth-accounts";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/accounts";

const SubscriptionAction = Schema.Struct({
  intent: Schema.Literals(["add", "cancel", "select", "remove", "rename"]),
  provider: SubscriptionAccountProvider,
  label: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
});
const Action = Schema.Union([SubscriptionAction, CompatibleAccountCommand]);
/** Views are tagged by connection kind, the way `/api/accounts` serves every provider. */
const subscriptionView = <A extends object>(view: A) => ({
  type: "subscription" as const,
  ...view,
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
      if (provider === "openai-compatible") return yield* compatibleAccounts;
      if (!Schema.is(SubscriptionAccountProvider)(provider))
        return reply({ error: "invalid_provider" }, 400);
      return yield* Effect.gen(function* () {
        const { sqlite } = yield* Database;
        // Preserve existing auth even if OS keychain import fails. Subsequent requests retry.
        yield* Effect.promise(() =>
          importLegacyOAuthProfile({ sqlite: sqlite, provider: provider }).catch(() => null),
        );
        return reply(subscriptionView(accountLoginManager(sqlite).profiles(provider)));
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
      const command = decoded.success;
      switch (command.provider) {
        case "openai-compatible":
          return yield* compatibleAccountAction(command);
        case "openai":
        case "anthropic":
          break;
      }
      const { intent, provider, label, accountId } = command;
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
        const events = yield* AppEvents;
        if (intent === "add") {
          const started = yield* Effect.tryPromise(() => manager.start(provider, label!));
          // The login finishes in another tab; pages hear it instead of polling.
          yield* Effect.forkDetach(
            Effect.promise(() => manager.settled(provider)).pipe(
              Effect.ensuring(Effect.sync(() => events.publishGlobal("auth"))),
            ),
          );
          return reply(subscriptionView(started));
        }
        if (intent === "cancel")
          return reply(subscriptionView(yield* Effect.tryPromise(() => manager.cancel(provider))));
        if (intent === "remove")
          yield* Effect.tryPromise(() =>
            removeOAuthProfile({ sqlite: sqlite, provider: provider, id: accountId! }),
          );
        else if (intent === "rename") renameOAuthProfile(sqlite, provider, accountId!, label!);
        else
          yield* Effect.tryPromise(() =>
            selectOAuthProfile({ sqlite: sqlite, provider: provider, id: accountId! }),
          );
        return reply(subscriptionView(manager.profiles(provider)));
      }).pipe(
        // Never expose keychain/native OAuth errors or tokens to the browser.
        Effect.catchCause(() => Effect.succeed(reply({ error: "account_action_failed" }, 409))),
      );
    }),
  );
}
