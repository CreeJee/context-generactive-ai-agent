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
    let client = cache.get(key);
    if (!client) {
      client = createClient(id);
      cache.set(key, client);
    }
    return client;
  };
  const legacyAllowed = () =>
    listOAuthProfiles(sqlite, provider).length === 0 &&
    !sqlite.prepare("SELECT provider FROM oauth_legacy_removed WHERE provider = ?").get(provider);
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
      startLogin: async () => {
        const id = randomUUID();
        const attempt = await clientFor(id).startLogin();
        let cancelled = false;
        const completed = attempt.completed
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
      disconnect: async () => {
        const id = selectedId();
        if (id !== null) await removeOAuthProfile(sqlite, provider, id, accounts, legacy);
        else if (legacyAllowed()) {
          const finishRemoval = beginOAuthProfileRemoval(sqlite, provider, "__legacy__");
          try {
            await clientFor(null).disconnect();
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
