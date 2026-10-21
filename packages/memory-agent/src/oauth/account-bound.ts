import { nativePromise } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { Effect, MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import { Crypto } from "effect";
import {
  createProfileCredentialStore,
  type OAuthProfiles,
  type ProfileCredentialStore,
} from "./accounts.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import {
  createKeychainProfileCredentialStore,
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type SubscriptionOAuthClient,
} from "./validation-harness.ts";

const cleanupFailed = (error: string) => Effect.logWarning("OAuth login cleanup failed", { error });

/** Synchronous selection at request/run creation; each profile owns its client and refresh lock. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function createAccountBoundSubscriptionClients(options: {
  readonly profiles: OAuthProfiles["Service"];
  readonly provider: OAuthProvider;
  readonly createClient?: ((id: string | null) => SubscriptionOAuthClient) | undefined;
  readonly accounts?: ProfileCredentialStore | undefined;
  readonly legacy?: CredentialStore | undefined;
}) {
  return createAccountBoundSubscriptionClientsBody(
    options.profiles,
    options.provider,
    options.createClient,
    options.accounts,
    options.legacy,
  );
}
function createAccountBoundSubscriptionClientsBody(
  profiles: OAuthProfiles["Service"],
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
    profiles.committed(provider).profiles.find((profile) => profile.selected)?.id ?? null;
  const clientFor = (id: string | null) => {
    const key = id ?? "__legacy__";
    const configured = profiles.committed(provider).profiles;
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
  const legacyAllowed = () => {
    const committed = profiles.committed(provider);
    return committed.profiles.length === 0 && !committed.legacyRemoved;
  };
  const current = () => {
    const id = selectedId();
    if (id !== null) return clientFor(id);
    if (legacyAllowed()) return clientFor(null);
    throw OAuthHarnessError.fromCode("not_connected");
  };
  return {
    catalogKey: () => selectedId() ?? (legacyAllowed() ? "__legacy__" : "__none__"),
    // A run calls this once at adapter creation. Later global selection changes cannot move it.
    forRun: () => {
      const id = selectedId();
      if (id === null && !legacyAllowed()) throw OAuthHarnessError.fromCode("not_connected");
      const releaseRun = profiles.acquireRun(provider, id ?? "__legacy__");
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
        runOAuthNodeEffect(
          Effect.gen(function* () {
            const id = yield* (yield* Crypto.Crypto).randomUUIDv4();
            const attempt = yield* nativePromise(() => clientFor(id).startLogin()).pipe(
              Effect.onError(() => Effect.sync(() => MutableHashMap.remove(cache, id))),
            );
            let cancelled = false;
            // The login SDK owns this completion and its explicit cancel callback across requests.
            const completed = runOAuthNodeEffect(
              nativePromise(() => attempt.completed).pipe(
                Effect.flatMap((connection) =>
                  Effect.gen(function* () {
                    if (cancelled) return yield* OAuthHarnessError.fromCode("cancelled");
                    if (!connection.connected)
                      return yield* OAuthHarnessError.fromCode("not_connected");
                    yield* profiles.publish(
                      provider,
                      id,
                      provider === "openai" ? "ChatGPT" : "Claude",
                      accounts,
                    );
                    if (selectedId() === null) yield* profiles.select(provider, id, accounts);
                    return connection;
                  }),
                ),
                Effect.onError(() =>
                  Effect.gen(function* () {
                    // A published account survives a selection failure or late cancellation.
                    if (!(yield* profiles.list(provider)).some((profile) => profile.id === id)) {
                      yield* nativePromise(() => accounts.remove(provider, id));
                      MutableHashMap.remove(cache, id);
                    }
                  }).pipe(
                    // Cleanup only: the login's own failure stands, so this one is logged by tag.
                    Effect.catchTags({
                      OAuthProfileStoreFailed: () => cleanupFailed("OAuthProfileStoreFailed"),
                      UnknownError: () => cleanupFailed("UnknownError"),
                    }),
                  ),
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
        runOAuthNodeEffect(
          Effect.gen(function* () {
            const id = selectedId();
            if (id !== null) {
              yield* profiles.remove(provider, id, accounts, legacy);
              MutableHashMap.remove(cache, id);
            } else if (legacyAllowed()) {
              yield* profiles.whileRemoving(
                provider,
                "__legacy__",
                nativePromise(() => clientFor(null).disconnect()).pipe(
                  Effect.tap(() => Effect.sync(() => MutableHashMap.remove(cache, "__legacy__"))),
                ),
              );
            } else return yield* OAuthHarnessError.fromCode("not_connected");
            const next = selectedId();
            return next !== null
              ? yield* nativePromise(() => clientFor(next).status())
              : { provider, connected: false, expiresAt: null };
          }),
        ),
    },
  };
}
