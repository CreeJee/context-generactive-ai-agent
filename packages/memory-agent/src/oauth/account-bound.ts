import { Crypto, Effect, Fiber, HashMap, Option, Ref, Scope, SynchronizedRef } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  createProfileCredentialStore,
  type OAuthProfile,
  type OAuthProfileRejected,
  type OAuthProfiles,
  type OAuthProfileStoreFailed,
  type ProfileCredentialStore,
} from "./accounts.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  OAuthKeychain,
  type CredentialStore,
  type LoginAttempt,
  type OAuthConnectionStatus,
  type SubscriptionOAuthClient,
} from "./validation-harness.ts";

const cleanupFailed = (error: string) => Effect.logWarning("OAuth login cleanup failed", { error });

const legacyKey = "__legacy__";

/** What adding an account fails with once the browser login itself has succeeded. */
export type AccountLoginFailure =
  | OAuthHarnessError
  | OAuthProfileRejected
  | OAuthProfileStoreFailed;

/** The selected account of a provider's committed profiles, and whether the legacy one may run. */
const selectionOf = (committed: {
  readonly profiles: ReadonlyArray<OAuthProfile>;
  readonly legacyRemoved: boolean;
}) => ({
  id: committed.profiles.find((profile) => profile.selected)?.id ?? null,
  legacyAllowed: committed.profiles.length === 0 && !committed.legacyRemoved,
  configured: committed.profiles,
});

/** Selection at request/run creation; each profile owns its client and refresh lock. */
export const createAccountBoundSubscriptionClients = Effect.fnUntraced(function* (options: {
  readonly profiles: OAuthProfiles["Service"];
  readonly provider: OAuthProvider;
  readonly createClient?:
    | ((id: string | null) => Effect.Effect<SubscriptionOAuthClient>)
    | undefined;
  readonly accounts?: ProfileCredentialStore | undefined;
  readonly legacy?: CredentialStore | undefined;
}) {
  const { profiles, provider, legacy } = options;
  const vault = yield* OAuthKeychain;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* Effect.context<Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner>();
  const protocol = providerProtocols[provider];
  const createClient =
    options.createClient ??
    ((id: string | null) =>
      // The legacy account keeps the client's own credential entry; a profile id is always valid.
      (id === null ? Effect.succeed(vault.store) : Effect.orDie(vault.profileStore(id))).pipe(
        Effect.flatMap((store) => createSubscriptionOAuthClient({ protocol, store })),
        Effect.provideContext(platform),
      ));
  const accounts = options.accounts ?? createProfileCredentialStore(vault.profileStore);
  const cache = yield* SynchronizedRef.make(HashMap.empty<string, SubscriptionOAuthClient>());
  const selection = Effect.map(profiles.snapshot(provider), selectionOf);
  const forget = (key: string) => SynchronizedRef.update(cache, HashMap.remove(key));
  const clientFor = (id: string | null) =>
    SynchronizedRef.modifyEffect(cache, (clients) =>
      Effect.flatMap(selection, ({ configured }) => {
        const key = id ?? legacyKey;
        // Clients of removed accounts go; the legacy one goes once any account is configured.
        const kept = HashMap.filter(clients, (_, cachedId) =>
          cachedId === legacyKey
            ? configured.length === 0
            : cachedId === key || configured.some((profile) => profile.id === cachedId),
        );
        return Option.match(HashMap.get(kept, key), {
          onSome: (client) => Effect.succeed([client, kept] as const),
          onNone: () =>
            Effect.map(
              createClient(id),
              (client) => [client, HashMap.set(kept, key, client)] as const,
            ),
        });
      }),
    );
  const current = Effect.flatMap(selection, ({ id, legacyAllowed }) =>
    id === null && !legacyAllowed
      ? Effect.fail(OAuthHarnessError.fromCode("not_connected"))
      : clientFor(id),
  );
  const signedOut: OAuthConnectionStatus = { provider, connected: false, expiresAt: null };

  /** Explicit login always creates a fresh slot, including after legacy account removal. */
  const startLogin = Effect.gen(function* () {
    const id = yield* Effect.orDie(crypto.randomUUIDv4());
    const attempt = yield* Effect.flatMap(clientFor(id), (client) => client.startLogin()).pipe(
      Effect.onError(() => forget(id)),
    );
    const cancelled = yield* Ref.make(false);
    // The account is published when the login completes, whether or not anything waits for it.
    const completion = yield* Effect.forkDetach(
      attempt.completed.pipe(
        Effect.flatMap((connection) =>
          Effect.gen(function* () {
            yield* Effect.when(
              Effect.fail(OAuthHarnessError.fromCode("cancelled")),
              Ref.get(cancelled),
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
              Effect.map(selection, (selected) => selected.id === null),
            );
            return connection;
          }),
        ),
        Effect.onError(() =>
          // A published account survives a selection failure or late cancellation.
          Effect.when(
            Effect.andThen(accounts.remove(provider, id), forget(id)),
            Effect.map(
              profiles.list(provider),
              (listed) => !listed.some((profile) => profile.id === id),
            ),
          ).pipe(
            // Cleanup only: the login's own failure stands, so this one is logged by tag.
            Effect.catchTags({
              OAuthProfileStoreFailed: () => cleanupFailed("OAuthProfileStoreFailed"),
              OAuthHarnessError: () => cleanupFailed("OAuthHarnessError"),
              OAuthProfileIdRejected: () => cleanupFailed("OAuthProfileIdRejected"),
            }),
          ),
        ),
      ),
    );
    const login: LoginAttempt<AccountLoginFailure> = {
      provider: attempt.provider,
      authorizationUrl: attempt.authorizationUrl,
      completed: Fiber.join(completion),
      cancel: Effect.andThen(Ref.set(cancelled, true), attempt.cancel),
    };
    return login;
  });

  const disconnect = Effect.gen(function* () {
    const { id, legacyAllowed } = yield* selection;
    yield* Option.match(Option.fromNullishOr(id), {
      onSome: (selected) =>
        Effect.andThen(profiles.remove(provider, selected, accounts, legacy), forget(selected)),
      onNone: () =>
        legacyAllowed
          ? profiles.whileRemoving(
              provider,
              legacyKey,
              Effect.flatMap(clientFor(null), (client) => client.disconnect).pipe(
                Effect.tap(() => forget(legacyKey)),
              ),
            )
          : Effect.fail(OAuthHarnessError.fromCode("not_connected")),
    });
    return yield* Option.match(Option.fromNullishOr((yield* selection).id), {
      onSome: (next) => Effect.flatMap(clientFor(next), (client) => client.status),
      onNone: () => Effect.succeed(signedOut),
    });
  });

  // A run calls this once at adapter creation. Later global selection changes cannot move it.
  const forRun: Effect.Effect<
    SubscriptionOAuthClient,
    OAuthHarnessError | OAuthProfileRejected,
    Scope.Scope
  > = Effect.gen(function* () {
    const { id, legacyAllowed } = yield* selection;
    yield* Effect.when(
      Effect.fail(OAuthHarnessError.fromCode("not_connected")),
      Effect.succeed(id === null && !legacyAllowed),
    );
    yield* profiles.acquireRun(provider, id ?? legacyKey);
    return yield* clientFor(id);
  });

  return {
    catalogKey: () => {
      const { id, legacyAllowed } = selectionOf(profiles.committed(provider));
      return id ?? (legacyAllowed ? legacyKey : "__none__");
    },
    /** The selected account's client, held for the run until its scope closes. */
    forRun,
    client: {
      status: Effect.flatMap(selection, ({ id, legacyAllowed }) =>
        id !== null || legacyAllowed
          ? Effect.flatMap(current, (client) => client.status)
          : Effect.succeed(signedOut),
      ),
      modelCatalog: Effect.flatMap(current, (client) => client.modelCatalog),
      startLogin,
      disconnect,
    },
  };
});
