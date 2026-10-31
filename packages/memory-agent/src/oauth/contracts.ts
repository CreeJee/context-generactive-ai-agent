import { Schema } from "effect";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";

/**
 * Subscription accounts as the page receives them (`/api/accounts`, `/api/accounts/quota`). This
 * module imports no server code, so the browser bundle can use it.
 */

/** A local OAuth profile, without its credential. */
export const OAuthProfile = Schema.Struct({
  id: Schema.String,
  provider: SubscriptionAccountProvider,
  label: Schema.String,
  selected: Schema.Boolean,
  createdAt: Schema.Finite,
});
export type OAuthProfile = typeof OAuthProfile.Type;

const LoginState = Schema.TaggedUnion({
  idle: {},
  completed: {},
  pending: { authorizationUrl: Schema.String },
  error: { error: Schema.Literals(["login_failed", "credential_unavailable"]) },
});
/** Where a provider's add-account login stands, as the account page shows it. */
export type AccountLoginState = typeof LoginState.Type;

/** One provider's profiles and its add-account login, tagged by connection kind. */
export const SubscriptionAccountsView = Schema.TaggedStruct("subscription", {
  profiles: Schema.Array(OAuthProfile),
  login: LoginState,
});
export type SubscriptionAccountsView = typeof SubscriptionAccountsView.Type;

/**
 * A provider-reported window. `usedPercent` is the provider's own percentage of this named window,
 * never a count of local responses or tokens.
 */
export const SubscriptionQuotaWindow = Schema.Struct({
  name: Schema.String,
  usedPercent: Schema.Finite,
  windowSeconds: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(Schema.String),
});
export type SubscriptionQuotaWindow = typeof SubscriptionQuotaWindow.Type;

/**
 * Why no quota can be shown. `credential_expired`: the stored token has expired and a quota lookup
 * does not refresh it; a model request with the account renews it. `lookup_failed`: the provider
 * lookup failed and no earlier observation exists.
 */
export const SubscriptionQuotaUnavailableReason = Schema.Literals([
  "credential_expired",
  "lookup_failed",
]);
export type SubscriptionQuotaUnavailableReason = typeof SubscriptionQuotaUnavailableReason.Type;

/** `stale` keeps the last observation and when the newer lookup failed; it is never reset to zero. */
export const SubscriptionQuotaStatus = Schema.TaggedUnion({
  observed: {
    windows: Schema.Array(SubscriptionQuotaWindow),
    observedAt: Schema.String,
  },
  stale: {
    windows: Schema.Array(SubscriptionQuotaWindow),
    observedAt: Schema.String,
    failedAt: Schema.String,
  },
  unavailable: { reason: SubscriptionQuotaUnavailableReason },
});
export type SubscriptionQuotaStatus = typeof SubscriptionQuotaStatus.Type;

export const SubscriptionAccountQuota = Schema.Struct({
  accountId: Schema.String,
  label: Schema.String,
  selected: Schema.Boolean,
  quota: SubscriptionQuotaStatus,
});
export type SubscriptionAccountQuota = typeof SubscriptionAccountQuota.Type;

export const SubscriptionQuotaReport = Schema.Struct({
  provider: SubscriptionAccountProvider,
  checkedAt: Schema.String,
  accounts: Schema.Array(SubscriptionAccountQuota),
});
export type SubscriptionQuotaReport = typeof SubscriptionQuotaReport.Type;
