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
export function createOAuthAccountLoginManager(
  sqlite: DatabaseSync,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  startLogin: LoginStarter = (provider, id) =>
    createSubscriptionOAuthClient({
      protocol: providerProtocols[provider],
      store: createKeychainProfileCredentialStore(id),
    }).startLogin(),
) {
  const pending = new Map<OAuthProvider, Attempt>();
  const result = new Map<OAuthProvider, AccountLoginState>();
  const state = (provider: OAuthProvider): AccountLoginState => {
    const attempt = pending.get(provider);
    if (attempt?.login)
      return { status: "pending", authorizationUrl: attempt.login.authorizationUrl };
    return result.get(provider) ?? { status: "idle" };
  };
  const profiles = (provider: OAuthProvider) => ({
    profiles: listOAuthProfiles(sqlite, provider),
    login: state(provider),
  });
  const start = async (provider: OAuthProvider, label: string) => {
    if (!label.trim() || label.length > 80) throw new Error("invalid_oauth_profile");
    if (pending.has(provider)) throw new Error("oauth_login_in_progress");
    const attempt: Attempt = { id: randomUUID(), label: label.trim(), cancelled: false };
    pending.set(provider, attempt);
    result.set(provider, { status: "idle" });
    try {
      attempt.login = await startLogin(provider, attempt.id);
      if (attempt.cancelled) attempt.login.cancel();
      attempt.completed = attempt.login.completed
        .then(async (connection) => {
          if (!connection.connected || attempt.cancelled) throw new Error("login_failed");
          // The callback has already persisted and verified the new slot at this point.
          await publishOAuthProfile(sqlite, provider, attempt.id, attempt.label, accounts);
          if (!listOAuthProfiles(sqlite, provider).some((profile) => profile.selected))
            await selectOAuthProfile(sqlite, provider, attempt.id, accounts);
          result.set(provider, { status: "completed" });
        })
        .catch(async () => {
          // Never delete an account that was published while a cancellation raced the final read.
          if (!listOAuthProfiles(sqlite, provider).some((profile) => profile.id === attempt.id)) {
            try {
              await accounts.remove(provider, attempt.id);
            } catch {
              /* retry not safe: keep error */
            }
            result.set(provider, { status: "error", error: "login_failed" });
          } else {
            result.set(provider, { status: "completed" });
          }
        })
        .finally(() => {
          if (pending.get(provider) === attempt) pending.delete(provider);
        });
      // The callback is asynchronous. Its rejection is handled above before this function returns.
      return profiles(provider);
    } catch {
      pending.delete(provider);
      result.set(provider, { status: "error", error: "credential_unavailable" });
      return profiles(provider);
    }
  };
  const cancel = async (provider: OAuthProvider) => {
    const attempt = pending.get(provider);
    if (attempt) {
      attempt.cancelled = true;
      attempt.login?.cancel();
      await attempt.completed;
    }
    return profiles(provider);
  };
  return { profiles, start, cancel };
}
