import { Effect, Match, Struct } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  AppEvents,
  AuthConnectionState,
  logFailure,
  OAuthAccountLogins,
  OAuthProfiles,
  OpenAICompatibleSettings,
  providerConnection,
  ProviderRegistry,
  type SubscriptionAccountProvider,
  SubscriptionQuota,
} from "memory-agent";
import {
  AppApi,
  type ProviderAuthState,
  type SubscriptionAccountCommand,
  SubscriptionAccountsView,
} from "memory-agent/app-api";
import { accountRefusal } from "../account-failures.ts";
import { compatibleAccountAction, compatibleAccounts } from "../compatible-handlers.ts";

/** The page receives a pending login's URL as `authUrl`. */
const browserState = (state: AuthConnectionState): ProviderAuthState =>
  AuthConnectionState.$is("pending")(state)
    ? { ...Struct.omit(state, ["authorizationUrl"]), authUrl: state.authorizationUrl }
    : state;

/**
 * Copies the provider's legacy login into a profile. If the vault is unavailable, the legacy
 * connection stays usable and the next read retries the copy; the request never fails for it.
 */
const importLegacyLogin = (
  profiles: OAuthProfiles["Service"],
  provider: SubscriptionAccountProvider,
) =>
  profiles
    .importLegacy(provider)
    .pipe(Effect.catch(logFailure("Legacy OAuth account import failed")));

/** A name or label a person can read: not blank, at most 80 characters. */
const checkLabel = (label: string) =>
  Effect.when(
    Effect.fail({ error: "invalid_account_label" } as const),
    Effect.succeed(label.trim() === "" || label.length > 80),
  );
const checkAccountId = (accountId: string) =>
  Effect.when(
    Effect.fail({ error: "invalid_account_id" } as const),
    Effect.succeed(accountId === "" || accountId.length > 128),
  );

/** The provider's connection could not be read or changed. */
const providerRefusal = {
  ProviderUnavailable: () => Effect.fail({ error: "provider_unavailable" } as const),
  ProviderOperationFailed: () => Effect.fail({ error: "auth_failed" } as const),
};

/** The auth group of `AppApi` (`/api/auth`). */
export const AuthApiHandlers = HttpApiBuilder.group(
  AppApi,
  "auth",
  Effect.fn(function* (handlers) {
    const registry = yield* ProviderRegistry;
    const profiles = yield* OAuthProfiles;
    const events = yield* AppEvents;

    return handlers.handleAll({
      status: ({ query: { provider } }) =>
        Effect.gen(function* () {
          const configured = yield* registry.get(provider);
          // Migrate when the sidebar first checks this provider.
          yield* Match.valueTags(providerConnection(provider), {
            subscription: ({ accountProvider }) => importLegacyLogin(profiles, accountProvider),
            "compatible-endpoint": () => Effect.void,
          });
          return browserState(yield* configured.auth.status);
        }).pipe(
          Effect.catchTags(providerRefusal),
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail({ error: "auth_failed", reason: "auth_status_timeout" } as const),
          }),
        ),
      action: ({ payload: { intent, provider } }) =>
        Effect.gen(function* () {
          const { auth } = yield* registry.get(provider);
          const operations = { login: auth.connect, logout: auth.disconnect, cancel: auth.cancel };
          const state = yield* operations[intent];
          yield* events.publishGlobal("auth");
          yield* Effect.forkDetach(
            auth.status.pipe(
              Effect.delay("250 millis"),
              Effect.repeat({ until: (now) => !AuthConnectionState.$is("pending")(now) }),
              Effect.catch(logFailure("OAuth login status polling stopped")),
              // Pages re-read the state however the wait ended.
              Effect.ensuring(events.publishGlobal("auth")),
            ),
          ).pipe(Effect.when(Effect.succeed(AuthConnectionState.$is("pending")(state))));
          return browserState(state);
        }).pipe(Effect.catchTags(providerRefusal)),
    });
  }),
);

/** The accounts group of `AppApi` (`/api/accounts/*`). */
export const AccountsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "accounts",
  Effect.fn(function* (handlers) {
    const profiles = yield* OAuthProfiles;
    const logins = yield* OAuthAccountLogins;
    const events = yield* AppEvents;
    const quota = yield* SubscriptionQuota;
    const compatibleSettings = yield* OpenAICompatibleSettings;

    const subscriptionAction = (command: SubscriptionAccountCommand) =>
      Match.value(command).pipe(
        Match.discriminatorsExhaustive("intent")({
          add: ({ provider, label }) =>
            Effect.gen(function* () {
              yield* checkLabel(label);
              const started = yield* logins.start(provider, label);
              // The login finishes in another tab; pages hear it instead of polling.
              yield* Effect.forkDetach(
                logins.settled(provider).pipe(Effect.ensuring(events.publishGlobal("auth"))),
              );
              return started;
            }),
          cancel: ({ provider }) => logins.cancel(provider),
          select: ({ provider, accountId }) =>
            checkAccountId(accountId).pipe(
              Effect.andThen(profiles.select(provider, accountId)),
              Effect.andThen(logins.profiles(provider)),
            ),
          remove: ({ provider, accountId }) =>
            checkAccountId(accountId).pipe(
              Effect.andThen(profiles.remove(provider, accountId)),
              Effect.andThen(logins.profiles(provider)),
            ),
          rename: ({ provider, accountId, label }) =>
            Effect.all([checkLabel(label), checkAccountId(accountId)]).pipe(
              Effect.andThen(profiles.rename(provider, accountId, label)),
              Effect.andThen(logins.profiles(provider)),
            ),
        }),
        Effect.map((accounts) => SubscriptionAccountsView.make(accounts)),
        // Never expose keychain/native OAuth errors or tokens to the browser.
        Effect.catchTags(accountRefusal),
      );

    return handlers.handleAll({
      list: ({ query: { provider } }) =>
        Match.valueTags(providerConnection(provider), {
          subscription: ({ accountProvider }) =>
            importLegacyLogin(profiles, accountProvider).pipe(
              Effect.andThen(logins.profiles(accountProvider)),
              Effect.map((accounts) => SubscriptionAccountsView.make(accounts)),
              Effect.catchTag("OAuthProfileStoreFailed", () =>
                Effect.fail({ error: "account_list_unavailable" } as const),
              ),
            ),
          "compatible-endpoint": () =>
            Effect.provideService(compatibleAccounts, OpenAICompatibleSettings, compatibleSettings),
        }),
      action: ({ payload }) =>
        payload.provider === "openai-compatible"
          ? Effect.provideService(
              compatibleAccountAction(payload),
              OpenAICompatibleSettings,
              compatibleSettings,
            )
          : subscriptionAction(payload),
      quota: ({ query: { provider } }) =>
        quota
          .accounts(provider)
          .pipe(
            Effect.catchTag("SubscriptionQuotaError", () =>
              Effect.fail({ error: "quota_status_unavailable" } as const),
            ),
          ),
    });
  }),
);

/** The models group of `AppApi` (`/api/models/*`). */
export const ModelsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "models",
  Effect.fn(function* (handlers) {
    const registry = yield* ProviderRegistry;
    const catalogRefusal = {
      ProviderUnavailable: () => Effect.fail({ error: "provider_unavailable" } as const),
      ProviderOperationFailed: () => Effect.fail({ error: "model_list_failed" } as const),
    };

    return handlers.handleAll({
      list: ({ query: { provider } }) =>
        Effect.gen(function* () {
          const configured = yield* registry.get(provider);
          const status = yield* configured.auth.status;
          if (!AuthConnectionState.$is("signed-in")(status))
            return yield* Effect.fail({
              error: "login_required",
              auth: browserState(status),
            } as const);
          return {
            models: yield* configured.models.list,
            // The settings file failing to read stays a 500, as before.
            selected: yield* Effect.orDie(configured.models.selected),
          };
        }).pipe(Effect.catchTags(catalogRefusal)),
      select: ({ params: { model }, payload: { provider, reasoningEffort } }) =>
        registry.get(provider).pipe(
          Effect.flatMap((configured) => configured.models.select(model, reasoningEffort)),
          Effect.catchTags({
            ...catalogRefusal,
            ModelUnavailable: (unavailable) =>
              Effect.fail({
                error: "model_unavailable",
                provider: unavailable.provider,
                model: unavailable.model,
                reasoningEffort: unavailable.reasoningEffort ?? null,
              } as const),
          }),
        ),
    });
  }),
);
