import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Effect, MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createProfileCredentialStore,
  listOAuthProfiles,
  publishOAuthProfileEffect,
  removeOAuthProfileEffect,
  selectOAuthProfileEffect,
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
  const cache = MutableHashMap.empty<string, SubscriptionOAuthClient>();
  const selectedId = () =>
    listOAuthProfiles(sqlite, provider).find((profile) => profile.selected)?.id ?? null;
  const clientFor = (id: string | null) => {
    const key = id ?? "__legacy__";
    const configured = listOAuthProfiles(sqlite, provider);
    for (const cachedId of MutableHashMap.keys(cache)) {
      if (
        cachedId !== key &&
        cachedId !== "__legacy__" &&
        !configured.some((profile) => profile.id === cachedId)
      )
        MutableHashMap.remove(cache, cachedId);
    }
    if (configured.length > 0) MutableHashMap.remove(cache, "__legacy__");
    let client = Option.getOrUndefined(MutableHashMap.get(cache, key));
    if (!isTruthy(client)) {
      client = createClient(id);
      MutableHashMap.set(cache, key, client);
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
      modelCatalog: (signal?: AbortSignal) => current().modelCatalog(signal),
      // Explicit login always creates a fresh slot, including after legacy account removal.
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      startLogin: () =>
        runNativeEffect(
          Effect.gen(function* () {
            const id = randomUUID();
            const attempt = yield* nativePromise(() => clientFor(id).startLogin()).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => MutableHashMap.remove(cache, id)).pipe(
                  Effect.andThen(Effect.failCause(cause)),
                ),
              ),
            );
            let cancelled = false;
            // The login SDK owns this completion and its explicit cancel callback across requests.
            const completed = runNativeEffect(
              nativePromise(() => attempt.completed).pipe(
                Effect.flatMap((connection) =>
                  Effect.gen(function* () {
                    if (cancelled) return yield* new OAuthHarnessError("cancelled");
                    if (!connection.connected) return yield* new OAuthHarnessError("not_connected");
                    yield* publishOAuthProfileEffect(
                      sqlite,
                      provider,
                      id,
                      provider === "openai" ? "ChatGPT" : "Claude",
                      accounts,
                    );
                    if (selectedId() === null)
                      yield* selectOAuthProfileEffect(sqlite, provider, id, accounts);
                    return connection;
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    // A published account survives a selection failure or late cancellation.
                    if (!listOAuthProfiles(sqlite, provider).some((profile) => profile.id === id)) {
                      yield* nativePromise(() => accounts.remove(provider, id));
                      MutableHashMap.remove(cache, id);
                    }
                    return yield* Effect.failCause(cause);
                  }),
                ),
              ),
            );
            return {
              ...attempt,
              completed,
              cancel: () => {
                cancelled = true;
                attempt.cancel();
              },
            };
          }),
        ),
      disconnect: () =>
        runNativeEffect(
          Effect.gen(function* () {
            const id = selectedId();
            if (id !== null) {
              yield* removeOAuthProfileEffect(sqlite, provider, id, accounts, legacy);
              MutableHashMap.remove(cache, id);
            } else if (legacyAllowed()) {
              const finishRemoval = beginOAuthProfileRemoval(sqlite, provider, "__legacy__");
              yield* nativePromise(() => clientFor(null).disconnect()).pipe(
                Effect.tap(() => Effect.sync(() => MutableHashMap.remove(cache, "__legacy__"))),
                Effect.ensuring(Effect.sync(finishRemoval)),
              );
            } else return yield* new OAuthHarnessError("not_connected");
            const next = selectedId();
            return next !== null
              ? yield* nativePromise(() => clientFor(next).status())
              : { provider, connected: false, expiresAt: null };
          }),
        ),
    },
  };
}
