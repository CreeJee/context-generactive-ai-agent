import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createProfileCredentialStore,
  listOAuthProfiles,
  publishOAuthProfile,
  removeOAuthProfile,
  selectOAuthProfile,
  type ProfileCredentialStore,
} from "./accounts.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import { acquireOAuthProfileRun, beginOAuthProfileRemoval } from "./run-leases.ts";
import {
  createKeychainProfileCredentialStore,
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type SubscriptionOAuthClient,
} from "./validation-harness.ts";

/** Synchronous selection at request/run creation; each profile owns its client and refresh lock. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function createAccountBoundSubscriptionClients(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  createClient: (id: string | null) => SubscriptionOAuthClient = (id) => {
    const protocol = providerProtocols[provider];
    if (id === null) return createSubscriptionOAuthClient({ protocol });
    return createSubscriptionOAuthClient({
      protocol,
      store: createKeychainProfileCredentialStore(id),
    });
  },
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy?: CredentialStore,
) {
  const cache = new Map<string, SubscriptionOAuthClient>();
  const selectedId = () =>
    listOAuthProfiles(sqlite, provider).find((profile) => profile.selected)?.id ?? null;
  const clientFor = (id: string | null) => {
    const key = id ?? "__legacy__";
    const configured = listOAuthProfiles(sqlite, provider);
    for (const cachedId of cache.keys()) {
      if (
        cachedId !== key &&
        cachedId !== "__legacy__" &&
        !configured.some((profile) => profile.id === cachedId)
      )
        cache.delete(cachedId);
    }
    if (configured.length > 0) cache.delete("__legacy__");
    let client = cache.get(key);
    if (!isTruthy(client)) {
      client = createClient(id);
      cache.set(key, client);
    }
    return client;
  };
  const legacyAllowed = () =>
    listOAuthProfiles(sqlite, provider).length === 0 &&
    !isTruthy(
      sqlite.prepare("SELECT provider FROM oauth_legacy_removed WHERE provider = ?").get(provider),
    );
  const current = () => {
    const id = selectedId();
    if (id !== null) return clientFor(id);
    if (legacyAllowed()) return clientFor(null);
    throw new OAuthHarnessError("not_connected");
  };
  return {
    catalogKey: () => selectedId() ?? (legacyAllowed() ? "__legacy__" : "__none__"),
    // A run calls this once at adapter creation. Later global selection changes cannot move it.
    forRun: () => {
      const id = selectedId();
      if (id === null && !legacyAllowed()) throw new OAuthHarnessError("not_connected");
      const releaseRun = acquireOAuthProfileRun(sqlite, provider, id ?? "__legacy__");
      try {
        return { ...clientFor(id), releaseRun };
      } catch (error) {
        releaseRun();
        throw error;
      }
    },
    client: {
      status: () =>
        selectedId() !== null || legacyAllowed()
          ? current().status()
          : Promise.resolve({ provider, connected: false, expiresAt: null }),
      modelCatalog: () => current().modelCatalog(),
      // Explicit login always creates a fresh slot, including after legacy account removal.
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      // @effect-diagnostics-next-line asyncFunction:off
      startLogin: async () => {
        const id = randomUUID();
        const attempt = await clientFor(id)
          .startLogin()
          .catch((error) => {
            cache.delete(id);
            throw error;
          });
        let cancelled = false;
        const completed = attempt.completed
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          // @effect-diagnostics-next-line asyncFunction:off
          .then(async (connection) => {
            if (cancelled) throw new OAuthHarnessError("cancelled");
            if (!connection.connected) throw new OAuthHarnessError("not_connected");
            await publishOAuthProfile(
              sqlite,
              provider,
              id,
              provider === "openai" ? "ChatGPT" : "Claude",
              accounts,
            );
            if (selectedId() === null) await selectOAuthProfile(sqlite, provider, id, accounts);
            return connection;
          })
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          // @effect-diagnostics-next-line asyncFunction:off
          .catch(async (error) => {
            // A published account must survive a selection failure or late cancellation.
            if (!listOAuthProfiles(sqlite, provider).some((profile) => profile.id === id)) {
              await accounts.remove(provider, id);
              cache.delete(id);
            }
            throw error;
          });
        return {
          ...attempt,
          completed,
          cancel: () => {
            cancelled = true;
            attempt.cancel();
          },
        };
      },
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      // @effect-diagnostics-next-line asyncFunction:off
      disconnect: async () => {
        const id = selectedId();
        if (id !== null) {
          await removeOAuthProfile(sqlite, provider, id, accounts, legacy);
          cache.delete(id);
        } else if (legacyAllowed()) {
          const finishRemoval = beginOAuthProfileRemoval(sqlite, provider, "__legacy__");
          try {
            await clientFor(null).disconnect();
            cache.delete("__legacy__");
          } finally {
            finishRemoval();
          }
        } else throw new OAuthHarnessError("not_connected");
        const next = selectedId();
        return next !== null
          ? clientFor(next).status()
          : { provider, connected: false, expiresAt: null };
      },
    },
  };
}
