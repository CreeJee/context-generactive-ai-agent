import { MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createProfileCredentialStore,
  listOAuthProfiles,
  publishOAuthProfile,
  selectOAuthProfile,
  type ProfileCredentialStore,
} from "./accounts.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import {
  createKeychainProfileCredentialStore,
  createSubscriptionOAuthClient,
  type LoginAttempt,
} from "./validation-harness.ts";

type LoginStarter = (provider: OAuthProvider, id: string) => Promise<LoginAttempt>;
type Attempt = {
  id: string;
  label: string;
  cancelled: boolean;
  login?: LoginAttempt;
  completed?: Promise<void>;
};
export type AccountLoginState =
  | { status: "idle" | "completed"; authorizationUrl?: never; error?: never }
  | { status: "pending"; authorizationUrl: string; error?: never }
  | { status: "error"; authorizationUrl?: never; error: "login_failed" | "credential_unavailable" };

/** Each login gets a fresh keychain slot; the legacy provider client is never used to add accounts. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function createOAuthAccountLoginManager(
  sqlite: DatabaseSync,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  startLogin: LoginStarter = (provider, id) =>
    createSubscriptionOAuthClient({
      protocol: providerProtocols[provider],
      store: createKeychainProfileCredentialStore(id),
    }).startLogin(),
) {
  type LoginEntry =
    | { readonly status: "running"; readonly attempt: Attempt; result: AccountLoginState }
    | { readonly status: "settled"; readonly result: AccountLoginState };
  const entries = MutableHashMap.empty<OAuthProvider, LoginEntry>();
  const activeAttempt = (provider: OAuthProvider) => {
    const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
    switch (entry?.status) {
      case "running":
        return entry.attempt;
      default:
        return undefined;
    }
  };
  const recordResult = (provider: OAuthProvider, value: AccountLoginState) => {
    const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
    switch (entry?.status) {
      case "running":
        entry.result = value;
        break;
      default:
        MutableHashMap.set(entries, provider, { status: "settled", result: value });
        break;
    }
  };
  const state = (provider: OAuthProvider): AccountLoginState => {
    const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
    switch (entry?.status) {
      case "running":
        return isTruthy(entry.attempt.login)
          ? { status: "pending", authorizationUrl: entry.attempt.login.authorizationUrl }
          : entry.result;
      case "settled":
        return entry.result;
      case undefined:
        return { status: "idle" };
    }
  };
  const profiles = (provider: OAuthProvider) => ({
    profiles: listOAuthProfiles(sqlite, provider),
    login: state(provider),
  });
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  // @effect-diagnostics-next-line asyncFunction:off
  const start = async (provider: OAuthProvider, label: string) => {
    if (!isTruthy(label.trim()) || label.length > 80) throw new Error("invalid_oauth_profile");
    if (isTruthy(activeAttempt(provider))) throw new Error("oauth_login_in_progress");
    const attempt: Attempt = { id: randomUUID(), label: label.trim(), cancelled: false };
    MutableHashMap.set(entries, provider, {
      status: "running",
      attempt,
      result: { status: "idle" },
    });
    try {
      attempt.login = await startLogin(provider, attempt.id);
      if (attempt.cancelled) attempt.login.cancel();
      attempt.completed = attempt.login.completed
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        // @effect-diagnostics-next-line asyncFunction:off
        .then(async (connection) => {
          if (!connection.connected || attempt.cancelled) throw new Error("login_failed");
          // The callback has already persisted and verified the new slot at this point.
          await publishOAuthProfile(sqlite, provider, attempt.id, attempt.label, accounts);
          if (!listOAuthProfiles(sqlite, provider).some((profile) => profile.selected))
            await selectOAuthProfile(sqlite, provider, attempt.id, accounts);
          recordResult(provider, { status: "completed" });
        })
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        // @effect-diagnostics-next-line asyncFunction:off
        .catch(async () => {
          // Never delete an account that was published while a cancellation raced the final read.
          if (!listOAuthProfiles(sqlite, provider).some((profile) => profile.id === attempt.id)) {
            try {
              await accounts.remove(provider, attempt.id);
            } catch {
              /* retry not safe: keep error */
            }
            recordResult(provider, { status: "error", error: "login_failed" });
          } else {
            recordResult(provider, { status: "completed" });
          }
        })
        .finally(() => {
          const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
          if (entry?.status === "running" && entry.attempt === attempt)
            MutableHashMap.set(entries, provider, { status: "settled", result: entry.result });
        });
      // The callback is asynchronous. Its rejection is handled above before this function returns.
      return profiles(provider);
    } catch {
      MutableHashMap.set(entries, provider, {
        status: "settled",
        result: { status: "error", error: "credential_unavailable" },
      });
      return profiles(provider);
    }
  };
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  // @effect-diagnostics-next-line asyncFunction:off
  const cancel = async (provider: OAuthProvider) => {
    const attempt = activeAttempt(provider);
    if (isTruthy(attempt)) {
      attempt.cancelled = true;
      attempt.login?.cancel();
      await attempt.completed;
    }
    return profiles(provider);
  };
  return { profiles, start, cancel };
}
