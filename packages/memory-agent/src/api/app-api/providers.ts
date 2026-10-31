import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { SubscriptionAccountsView, SubscriptionQuotaReport } from "../../oauth/contracts.ts";
import {
  ModelSelection,
  ProviderAuthState,
  ProviderId,
  ProviderModel,
  SubscriptionAccountProvider,
} from "../../providers/contracts.ts";
import {
  CompatibleAccountsView,
  CompatibleConnectionInput,
  CompatibleModelInput,
} from "../../providers/openai-compatible-config.ts";
import { NoStore } from "../no-store.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

const subscription = { provider: SubscriptionAccountProvider };
const profile = { ...subscription, accountId: Schema.String };
/**
 * - `add` { label }: starts an OAuth login into a new profile; `login` in the answer shows where.
 * - `cancel`: stops that login.
 * - `select` / `remove` { accountId }: runs use the profile from then on, or forgets it.
 * - `rename` { accountId, label }.
 */
export const SubscriptionAccountCommand = Schema.Union([
  Schema.Struct({ ...subscription, intent: Schema.Literal("add"), label: Schema.String }),
  Schema.Struct({ ...subscription, intent: Schema.Literal("cancel") }),
  Schema.Struct({ ...profile, intent: Schema.Literal("select") }),
  Schema.Struct({ ...profile, intent: Schema.Literal("remove") }),
  Schema.Struct({ ...profile, intent: Schema.Literal("rename"), label: Schema.String }),
]);
export type SubscriptionAccountCommand = typeof SubscriptionAccountCommand.Type;

const compatible = { provider: Schema.Literal("openai-compatible") };
const endpoint = { ...compatible, accountId: Schema.String.check(Schema.isMaxLength(128)) };
/** Commands for compatible endpoints; the intents both kinds have keep the subscription names. */
export const CompatibleAccountCommand = Schema.Union([
  Schema.Struct({
    ...compatible,
    intent: Schema.Literal("create"),
    label: Schema.optional(Schema.String),
    ...CompatibleConnectionInput.fields,
  }),
  Schema.Struct({
    ...endpoint,
    intent: Schema.Literal("connect"),
    ...CompatibleConnectionInput.fields,
  }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("rename"), label: Schema.String }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("save-model"), model: CompatibleModelInput }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("remove-model"), modelId: Schema.String }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("test"), modelId: Schema.String }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("select") }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("remove") }),
  Schema.Struct({ ...endpoint, intent: Schema.Literal("discover") }),
]);
export type CompatibleAccountCommand = typeof CompatibleAccountCommand.Type;

/** The endpoint answered a test request with the model. */
export const CompatibleTestResult = Schema.Struct({ ok: Schema.Literal(true) });
/** The model ids the endpoint lists, for suggestions when registering a model. */
export const CompatibleModelList = Schema.Struct({
  models: Schema.Array(Schema.Struct({ id: Schema.String })),
});

/** A provider's catalog and the global selection, or null before one is made. */
export const ModelCatalogView = Schema.Struct({
  models: Schema.Array(ProviderModel),
  selected: Schema.NullOr(ModelSelection),
});
export type ModelCatalogView = typeof ModelCatalogView.Type;

/** The provider is not configured in this app. */
const ProviderUnavailable = appRefusal(404, ["provider_unavailable"]);

/**
 * The selected model's provider cannot run now; `provider` names it. `ProviderUnavailable` matches
 * it too, so `providersRefusals` declares it first.
 */
export const SelectedProviderUnavailable = refusalWith({ provider: ProviderId })(503, [
  "provider_unavailable",
]);

/**
 * The provider's connection could not be read or changed. Reading it timed out after 10 seconds
 * when `reason` is `auth_status_timeout`; that refusal is declared first, since both match it.
 */
const AuthRefusals = [
  refusalWith({ reason: Schema.Literal("auth_status_timeout") })(504, ["auth_failed"]),
  appRefusal(502, ["auth_failed"]),
] as const;

/** The provider is not signed in; `auth` is its connection. */
const LoginRequired = refusalWith({ auth: ProviderAuthState })(401, ["login_required"]);

/** The provider's catalog could not be read. */
const ModelListFailed = appRefusal(502, ["model_list_failed"]);

/** The catalog has no such model, or the model has no such reasoning effort. */
const ModelUnavailable = refusalWith({
  provider: ProviderId,
  model: Schema.String,
  reasoningEffort: Schema.NullOr(Schema.String),
})(404, ["model_unavailable"]);

/** The profile list could not be read. */
const AccountListUnavailable = appRefusal(503, ["account_list_unavailable"]);

/** A subscription account change refused; keychain and provider causes stay on the server. */
const SubscriptionAccountRefusals = [
  appRefusal(400, ["invalid_account_label", "invalid_account_id", "invalid_oauth_profile"]),
  appRefusal(404, ["oauth_profile_not_found"]),
  appRefusal(409, [
    "oauth_profile_missing_credential",
    "oauth_profile_removing",
    "oauth_profile_in_use",
    "oauth_profile_conflicting_credential",
    "oauth_profile_copy_unverified",
    "login_in_progress",
  ]),
  appRefusal(502, ["account_login_failed"]),
  appRefusal(503, ["account_store_unavailable"]),
] as const;

/**
 * A compatible endpoint refused or failed. `settings_partially_saved`: the key or the settings
 * may be written without the other. `endpoint_unavailable`: the endpoint did not answer a test or
 * model list.
 */
const CompatibleRefusals = [
  appRefusal(400, ["invalid_settings"]),
  appRefusal(404, ["account_not_found"]),
  appRefusal(409, ["settings_partially_saved"]),
  appRefusal(500, ["keychain_failed", "settings_unavailable"]),
  appRefusal(502, ["endpoint_unavailable"]),
] as const;

/** The profile list could not be read, so no account's quota is known. */
const QuotaUnavailable = appRefusal(503, ["quota_status_unavailable"]);

/** Every refusal of the groups, for `appRefusalStatus`. */
export const providersRefusals = [
  SelectedProviderUnavailable,
  ProviderUnavailable,
  ...AuthRefusals,
  LoginRequired,
  ModelListFailed,
  ModelUnavailable,
  AccountListUnavailable,
  ...SubscriptionAccountRefusals,
  ...CompatibleRefusals,
  QuotaUnavailable,
];

/** A model provider's sign-in (`/api/auth`). */
export class AuthGroup extends HttpApiGroup.make("auth")
  .add(
    /**
     * The provider's connection; a subscription's legacy login is copied into a profile first.
     * Without `provider`, the app's current provider, the one its runs use (the ACP bridge asks so).
     */
    HttpApiEndpoint.get("status", "/api/auth", {
      query: { provider: Schema.optional(ProviderId) },
      success: ProviderAuthState,
      error: [ProviderUnavailable, ...AuthRefusals],
    }),
    /** Starts, cancels or disconnects a subscription's login; pages hear when it settles. */
    HttpApiEndpoint.post("action", "/api/auth", {
      payload: Schema.Struct({
        intent: Schema.Literals(["login", "cancel", "logout"]),
        ...subscription,
      }),
      success: ProviderAuthState,
      error: [ProviderUnavailable, ...AuthRefusals],
    }),
  )
  .middleware(SameSite) {}

/** Accounts of every provider (`/api/accounts/*`), tagged by connection kind. */
export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(
    /** A subscription's OAuth profiles and login, or a compatible provider's endpoints. */
    HttpApiEndpoint.get("list", "/api/accounts", {
      query: { provider: ProviderId },
      success: Schema.Union([SubscriptionAccountsView, CompatibleAccountsView]),
      error: [AccountListUnavailable, ...CompatibleRefusals],
    }),
    /**
     * Changes a subscription profile or a compatible endpoint and answers the provider's accounts;
     * a compatible `test` or `discover` answers its result instead.
     */
    HttpApiEndpoint.post("action", "/api/accounts", {
      payload: Schema.Union([SubscriptionAccountCommand, CompatibleAccountCommand]),
      success: Schema.Union([
        SubscriptionAccountsView,
        CompatibleAccountsView,
        CompatibleTestResult,
        CompatibleModelList,
      ]),
      error: [...SubscriptionAccountRefusals, ...CompatibleRefusals],
    }),
    /**
     * Each profile's quota as its provider reports it, or why it is unknown. Local token counts
     * are never shown instead.
     */
    HttpApiEndpoint.get("quota", "/api/accounts/quota", {
      query: subscription,
      success: SubscriptionQuotaReport,
      error: QuotaUnavailable,
    }),
  )
  .middleware(SameSite)
  .middleware(NoStore) {}

/** A provider's models and the global selection (`/api/models/*`). */
export class ModelsGroup extends HttpApiGroup.make("models")
  .add(
    /** The signed-in provider's catalog and the current selection. */
    HttpApiEndpoint.get("list", "/api/models", {
      query: { provider: ProviderId },
      success: ModelCatalogView,
      error: [LoginRequired, ProviderUnavailable, ModelListFailed],
    }),
    /** Checks and saves the provider, model and effort exactly as given; nothing falls back. */
    HttpApiEndpoint.post("select", "/api/models/:model", {
      params: { model: Schema.String },
      payload: Schema.Struct({
        provider: ProviderId,
        reasoningEffort: Schema.optional(Schema.NonEmptyString),
      }),
      success: ModelSelection,
      error: [ModelUnavailable, ProviderUnavailable, ModelListFailed],
    }),
  )
  .middleware(SameSite) {}
