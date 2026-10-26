import { nativePromise } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { Effect, MutableHashMap, Option } from "effect";
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
    // The legacy account keeps the client's own credential entry.
    return Option.match(Option.fromNullishOr(id), {
      onNone: () => createSubscriptionOAuthClient({ protocol }),
      onSome: (profile) =>
        createSubscriptionOAuthClient({
          protocol,
          store: createKeychainProfileCredentialStore(profile),
        }),
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
    // Clients of removed accounts go; the legacy one goes once any account is configured.
    Array.from(MutableHashMap.keys(cache))
      .filter((cachedId) =>
        cachedId === "__legacy__"
          ? configured.length > 0
          : cachedId !== key && !configured.some((profile) => profile.id === cachedId),
      )
      .forEach((cachedId) => MutableHashMap.remove(cache, cachedId));
    return Option.getOrElse(MutableHashMap.get(cache, key), () => {
      const client = createClient(id);
      MutableHashMap.set(cache, key, client);
      return client;
    });
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
                    yield* Effect.when(
                      Effect.fail(OAuthHarnessError.fromCode("cancelled")),
                      Effect.sync(() => cancelled),
                    );
                    yield* Effect.when(
                      Effect.fail(OAuthHarnessError.fromCode("not_connected")),
                      Effect.succeed(!connection.connected),
                    );
                    yield* profiles.publish(
                      provider,
                      id,
                      provider === "openai" ? "ChatGPT" : "Claude",
                      accounts,
                    );
                    yield* Effect.when(
                      profiles.select(provider, id, accounts),
                      Effect.sync(() => selectedId() === null),
                    );
                    return connection;
                  }),
                ),
                Effect.onError(() =>
                  // A published account survives a selection failure or late cancellation.
                  Effect.when(
                    Effect.andThen(
                      nativePromise(() => accounts.remove(provider, id)),
                      Effect.sync(() => MutableHashMap.remove(cache, id)),
                    ),
                    Effect.map(
                      profiles.list(provider),
                      (listed) => !listed.some((profile) => profile.id === id),
                    ),
                  ).pipe(
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
            yield* Option.match(Option.fromNullishOr(selectedId()), {
              onSome: (id) =>
                Effect.andThen(
                  profiles.remove(provider, id, accounts, legacy),
                  Effect.sync(() => MutableHashMap.remove(cache, id)),
                ),
              onNone: () =>
                legacyAllowed()
                  ? profiles.whileRemoving(
                      provider,
                      "__legacy__",
                      nativePromise(() => clientFor(null).disconnect()).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => MutableHashMap.remove(cache, "__legacy__")),
                        ),
                      ),
                    )
                  : Effect.fail(OAuthHarnessError.fromCode("not_connected")),
            });
            return yield* Option.match(Option.fromNullishOr(selectedId()), {
              onSome: (next) => nativePromise(() => clientFor(next).status()),
              onNone: () => Effect.succeed({ provider, connected: false, expiresAt: null }),
            });
          }),
        ),
    },
  };
}
