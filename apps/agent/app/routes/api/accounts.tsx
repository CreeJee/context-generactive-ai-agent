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

export async function loader({ request }: Route.LoaderArgs) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (!Schema.is(SubscriptionAccountProvider)(provider))
    return reply({ error: "invalid_provider" }, 400);
  try {
    return await agent.runPromise(
      Effect.gen(function* () {
        const { sqlite } = yield* Database;
        // Preserve existing auth even if OS keychain import fails. Subsequent requests retry.
        yield* Effect.promise(() => importLegacyOAuthProfile(sqlite, provider).catch(() => null));
        return reply(accountLoginManager(sqlite).profiles(provider));
      }),
    );
  } catch {
    return reply({ error: "account_list_unavailable" }, 503);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const decoded = await readJson(request, Action);
  if (Result.isFailure(decoded)) return reply({ error: "invalid_account_action" }, 400);
  const { intent, provider, label, accountId } = decoded.success;
  if ((intent === "add" || intent === "rename") && (!label?.trim() || label.length > 80))
    return reply({ error: "invalid_account_label" }, 400);
  if (
    (intent === "select" || intent === "remove" || intent === "rename") &&
    (!accountId || accountId.length > 128)
  )
    return reply({ error: "invalid_account_id" }, 400);
  try {
    return await agent.runPromise(
      Effect.gen(function* () {
        const { sqlite } = yield* Database;
        const manager = accountLoginManager(sqlite);
        if (intent === "add")
          return reply(yield* Effect.tryPromise(() => manager.start(provider, label!)));
        if (intent === "cancel")
          return reply(yield* Effect.tryPromise(() => manager.cancel(provider)));
        if (intent === "remove")
          yield* Effect.tryPromise(() => removeOAuthProfile(sqlite, provider, accountId!));
        else if (intent === "rename") renameOAuthProfile(sqlite, provider, accountId!, label!);
        else yield* Effect.tryPromise(() => selectOAuthProfile(sqlite, provider, accountId!));
        return reply(manager.profiles(provider));
      }),
    );
  } catch {
    // Never expose keychain/native OAuth errors or tokens to the browser.
    return reply({ error: "account_action_failed" }, 409);
  }
}
