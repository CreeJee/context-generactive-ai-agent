import { isTruthy } from "../../truthy.ts";
import { Data, Effect, Result, Schema } from "effect";
import {
  AppEvents,
  OAuthAccountLogins,
  OAuthProfiles,
  SubscriptionAccountProvider,
  logFailure,
  type AccountLoginState,
  type OAuthProfile,
} from "memory-agent";
import { answerAccountFailures } from "~/.server/account-failures";
import { agent } from "~/.server/agent";
import {
  CompatibleAccountCommand,
  compatibleAccountAction,
  compatibleAccounts,
} from "~/.server/compatible-handlers";
import { answerDefect, readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/accounts";

const SubscriptionAction = Schema.Struct({
  intent: Schema.Literals(["add", "cancel", "select", "remove", "rename"]),
  provider: SubscriptionAccountProvider,
  label: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
});
const Action = Schema.Union([SubscriptionAction, CompatibleAccountCommand]);
/** Views are tagged by connection kind, the way `/api/accounts` serves every provider. */
type SubscriptionView = Data.TaggedEnum<{
  subscription: { readonly profiles: readonly OAuthProfile[]; readonly login: AccountLoginState };
}>;
const SubscriptionView = Data.taggedEnum<SubscriptionView>();
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
        // Preserve existing auth even if OS keychain import fails. Subsequent requests retry.
        yield* (yield* OAuthProfiles)
          .importLegacy(provider)
          .pipe(Effect.catch(logFailure("Legacy OAuth account import failed")));
        return reply(
          SubscriptionView.subscription(yield* (yield* OAuthAccountLogins).profiles(provider)),
        );
      }).pipe(
        Effect.catchTag("OAuthProfileStoreFailed", () =>
          Effect.succeed(reply({ error: "account_list_unavailable" }, 503)),
        ),
      );
    }).pipe(answerDefect),
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
      const profiles = yield* OAuthProfiles;
      const manager = yield* OAuthAccountLogins;
      const events = yield* AppEvents;
      if (intent === "add") {
        const started = yield* manager.start(provider, label!);
        // The login finishes in another tab; pages hear it instead of polling.
        yield* Effect.forkDetach(
          manager.settled(provider).pipe(Effect.ensuring(events.publishGlobal("auth"))),
        );
        return reply(SubscriptionView.subscription(started));
      }
      if (intent === "cancel")
        return reply(SubscriptionView.subscription(yield* manager.cancel(provider)));
      switch (intent) {
        case "remove":
          yield* profiles.remove(provider, accountId!);
          break;
        case "rename":
          yield* profiles.rename(provider, accountId!, label!);
          break;
        case "select":
          yield* profiles.select(provider, accountId!);
          break;
      }
      return reply(SubscriptionView.subscription(yield* manager.profiles(provider)));
    }).pipe(
      // Never expose keychain/native OAuth errors or tokens to the browser.
      answerAccountFailures,
      answerDefect,
    ),
  );
}
