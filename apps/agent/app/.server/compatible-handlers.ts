import { Effect, Match } from "effect";
import {
  CompatibleAccountsView,
  OpenAICompatibleSettings,
  type GlobalConfigFailed,
  type OpenAICompatibleFailed,
  type OpenAICompatibleStatus,
} from "memory-agent";
import type { CompatibleAccountCommand } from "memory-agent/app-api";

/** The refusal for each operation of a compatible endpoint that fails. */
const operationRefusal = {
  validation: "invalid_settings",
  missing: "account_not_found",
  keychain: "keychain_failed",
  account_id: "settings_unavailable",
  partial: "settings_partially_saved",
  test: "endpoint_unavailable",
  models: "endpoint_unavailable",
} as const satisfies Record<OpenAICompatibleFailed["operation"], string>;

const accountsView = (status: OpenAICompatibleStatus) => CompatibleAccountsView.make(status);

/** Refuses each expected failure; keychain, config and endpoint causes stay on the server. */
const refuse = <A, R>(effect: Effect.Effect<A, OpenAICompatibleFailed | GlobalConfigFailed, R>) =>
  Effect.catchTags(effect, {
    GlobalConfigFailed: () => Effect.fail({ error: "settings_unavailable" } as const),
    OpenAICompatibleFailed: ({ operation }) => Effect.fail({ error: operationRefusal[operation] }),
  });

/** GET `/api/accounts?provider=openai-compatible`: every endpoint and its catalog, no secrets. */
export const compatibleAccounts = refuse(
  Effect.flatMap(OpenAICompatibleSettings, (settings) => Effect.map(settings.status, accountsView)),
);

/** POST `/api/accounts` for a compatible endpoint, as the contract decoded it. */
export const compatibleAccountAction = (command: CompatibleAccountCommand) =>
  refuse(
    Effect.flatMap(OpenAICompatibleSettings, (settings) =>
      Match.value(command).pipe(
        Match.discriminatorsExhaustive("intent")({
          create: (create) => Effect.map(settings.create(create), accountsView),
          connect: (connect) =>
            Effect.map(settings.connect(connect.accountId, connect), accountsView),
          rename: ({ accountId, label }) =>
            Effect.map(settings.rename(accountId, label), accountsView),
          "save-model": ({ accountId, model }) =>
            Effect.map(settings.saveModel(accountId, model), accountsView),
          "remove-model": ({ accountId, modelId }) =>
            Effect.map(settings.removeModel(accountId, modelId), accountsView),
          select: ({ accountId }) => Effect.map(settings.select(accountId), accountsView),
          remove: ({ accountId }) => Effect.map(settings.remove(accountId), accountsView),
          test: ({ accountId, modelId }) => settings.test(accountId, modelId),
          discover: ({ accountId }) =>
            Effect.map(settings.discover(accountId), (ids) => ({
              models: ids.map((id) => ({ id })),
            })),
        }),
      ),
    ),
  );
