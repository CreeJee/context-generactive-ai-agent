import {
  Context,
  Crypto,
  Data,
  Deferred,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  createProfileCredentialStore,
  OAuthProfileRejected,
  OAuthProfiles,
  type ProfileCredentialStore,
} from "./accounts.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  OAuthKeychain,
  type LoginAttempt,
} from "./validation-harness.ts";

type LoginStarter = (
  provider: OAuthProvider,
  id: string,
) => Effect.Effect<LoginAttempt, OAuthHarnessError>;
interface Attempt {
  readonly id: string;
  readonly label: string;
  readonly cancelled: Ref.Ref<boolean>;
  /** The started login; none while it is still starting. */
  readonly login: Ref.Ref<Option.Option<LoginAttempt>>;
  /** Done once the attempt has finished either way. */
  readonly settled: Deferred.Deferred<void>;
}
/** Where a provider's add-account login stands, as the account page shows it. */
export type AccountLoginState = Data.TaggedEnum<{
  idle: {};
  completed: {};
  pending: { readonly authorizationUrl: string };
  error: { readonly error: "login_failed" | "credential_unavailable" };
}>;
export const AccountLoginState = Data.taggedEnum<AccountLoginState>();

type LoginEntry = Data.TaggedEnum<{
  running: { readonly attempt: Attempt; readonly result: AccountLoginState };
  settled: { readonly result: AccountLoginState };
}>;
const LoginEntry = Data.taggedEnum<LoginEntry>();

/** Each login gets a fresh keychain slot; the legacy provider client is never used to add accounts. */
export const createOAuthAccountLoginManager = Effect.fnUntraced(function* (options: {
  readonly profiles: OAuthProfiles["Service"];
  readonly accounts?: ProfileCredentialStore | undefined;
  readonly startLogin?: LoginStarter | undefined;
}) {
  const store = options.profiles;
  const vault = yield* OAuthKeychain;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* Effect.context<Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner>();
  const accounts = options.accounts ?? createProfileCredentialStore(vault.profileStore);
  const startLogin: LoginStarter =
    options.startLogin ??
    ((provider, id) =>
      // A fresh slot's id is always a valid profile id.
      Effect.orDie(vault.profileStore(id)).pipe(
        Effect.flatMap((slot) =>
          createSubscriptionOAuthClient({ protocol: providerProtocols[provider], store: slot }),
        ),
        Effect.flatMap((client) => client.startLogin()),
        Effect.provideContext(platform),
      ));
  const entries = yield* SynchronizedRef.make(HashMap.empty<OAuthProvider, LoginEntry>());
  const runningEntry = (
    current: HashMap.HashMap<OAuthProvider, LoginEntry>,
    provider: OAuthProvider,
  ) => Option.filter(HashMap.get(current, provider), LoginEntry.$is("running"));
  const activeAttempt = (provider: OAuthProvider) =>
    Effect.map(SynchronizedRef.get(entries), (current) =>
      Option.map(runningEntry(current, provider), (entry) => entry.attempt),
    );
  const recordResult = (provider: OAuthProvider, value: AccountLoginState) =>
    SynchronizedRef.update(entries, (current) =>
      HashMap.set(
        current,
        provider,
        Option.match(runningEntry(current, provider), {
          onNone: () => LoginEntry.settled({ result: value }),
          onSome: (entry) => LoginEntry.running({ attempt: entry.attempt, result: value }),
        }),
      ),
    );
  const state = (provider: OAuthProvider) =>
    Effect.flatMap(SynchronizedRef.get(entries), (current) =>
      Option.match(HashMap.get(current, provider), {
        onNone: () => Effect.succeed<AccountLoginState>(AccountLoginState.idle()),
        onSome: LoginEntry.$match({
          running: (entry) =>
            Effect.map(Ref.get(entry.attempt.login), (login) =>
              Option.match(login, {
                onNone: () => entry.result,
                onSome: (started): AccountLoginState =>
                  AccountLoginState.pending({ authorizationUrl: started.authorizationUrl }),
              }),
            ),
          settled: (entry) => Effect.succeed(entry.result),
        }),
      }),
    );
  const profiles = (provider: OAuthProvider) =>
    Effect.all({ profiles: store.list(provider), login: state(provider) });

  /** The started login's outcome, published as an account; the attempt settles either way. */
  const complete = (provider: OAuthProvider, attempt: Attempt, login: LoginAttempt) =>
    login.completed.pipe(
      Effect.flatMap((connection) =>
        Effect.gen(function* () {
          yield* Effect.when(
            Effect.fail(OAuthHarnessError.fromCode("cancelled")),
            Ref.get(attempt.cancelled),
          );
          yield* Effect.when(
            Effect.fail(OAuthHarnessError.fromCode("not_connected")),
            Effect.succeed(!connection.connected),
          );
          yield* store.publish(provider, attempt.id, attempt.label, accounts);
          yield* Effect.when(
            store.select(provider, attempt.id, accounts),
            Effect.map(
              store.list(provider),
              (listed) => !listed.some((profile) => profile.selected),
            ),
          );
          yield* recordResult(provider, AccountLoginState.completed());
        }),
      ),
      // Any failed completion is the attempt's outcome; the page shows it as login_failed.
      Effect.catch(() =>
        Effect.flatMap(store.list(provider), (listed) =>
          listed.some((profile) => profile.id === attempt.id)
            ? recordResult(provider, AccountLoginState.completed())
            : // Best-effort removal of the unpublished slot; the login already failed.
              accounts.remove(provider, attempt.id).pipe(
                Effect.catchTags({
                  OAuthHarnessError: (error) =>
                    Effect.logWarning("OAuth login slot cleanup failed", {
                      error: "OAuthHarnessError",
                      code: error.code,
                    }),
                  OAuthProfileIdRejected: () =>
                    Effect.logWarning("OAuth login slot cleanup failed", {
                      error: "OAuthProfileIdRejected",
                    }),
                }),
                Effect.andThen(
                  recordResult(provider, AccountLoginState.error({ error: "login_failed" })),
                ),
              ),
        ),
      ),
      Effect.catchTag("OAuthProfileStoreFailed", () =>
        recordResult(provider, AccountLoginState.error({ error: "login_failed" })),
      ),
      Effect.ensuring(settle(provider, attempt)),
    );
  /** Only this attempt's own running entry settles; a newer login keeps its state. */
  const settle = (provider: OAuthProvider, attempt: Attempt) =>
    SynchronizedRef.update(entries, (current) =>
      Option.match(
        Option.filter(runningEntry(current, provider), (entry) => entry.attempt === attempt),
        {
          onNone: () => current,
          onSome: (entry) =>
            HashMap.set(current, provider, LoginEntry.settled({ result: entry.result })),
        },
      ),
    ).pipe(Effect.andThen(Deferred.succeed(attempt.settled, undefined)));

  const start = Effect.fn("OAuthAccountLogins.start")(function* (
    provider: OAuthProvider,
    label: string,
  ) {
    if (label.trim().length === 0 || label.length > 80)
      return yield* OAuthProfileRejected.make({ reason: "invalid_oauth_profile" });
    const attempt: Attempt = {
      id: yield* Effect.orDie(crypto.randomUUIDv4()),
      label: label.trim(),
      cancelled: yield* Ref.make(false),
      login: yield* Ref.make(Option.none<LoginAttempt>()),
      settled: yield* Deferred.make<void>(),
    };
    yield* SynchronizedRef.modifyEffect(entries, (current) =>
      Option.isSome(runningEntry(current, provider))
        ? Effect.fail(OAuthHarnessError.fromCode("login_in_progress"))
        : Effect.succeed([
            undefined,
            HashMap.set(
              current,
              provider,
              LoginEntry.running({ attempt, result: AccountLoginState.idle() }),
            ),
          ] as const),
    );
    return yield* Effect.gen(function* () {
      const login = yield* startLogin(provider, attempt.id);
      yield* Ref.set(attempt.login, Option.some(login));
      yield* Effect.when(login.cancel, Ref.get(attempt.cancelled));
      // Completion is owned by the login and its explicit cancel, across HTTP requests.
      yield* Effect.forkDetach(complete(provider, attempt, login));
      return yield* profiles(provider);
    }).pipe(
      // A login that cannot start leaves the provider's accounts as they were.
      Effect.catchTag("OAuthHarnessError", () =>
        SynchronizedRef.update(
          entries,
          HashMap.set<OAuthProvider, LoginEntry>(
            provider,
            LoginEntry.settled({
              result: AccountLoginState.error({ error: "credential_unavailable" }),
            }),
          ),
        ).pipe(
          Effect.andThen(Deferred.succeed(attempt.settled, undefined)),
          Effect.andThen(profiles(provider)),
        ),
      ),
    );
  });
  const cancel = Effect.fn("OAuthAccountLogins.cancel")(function* (provider: OAuthProvider) {
    yield* Effect.transposeOption(
      Option.map(yield* activeAttempt(provider), (attempt) =>
        Effect.gen(function* () {
          yield* Ref.set(attempt.cancelled, true);
          // A login still starting has no completion yet; its start sees the flag instead.
          yield* Effect.transposeOption(
            Option.map(yield* Ref.get(attempt.login), (login) =>
              Effect.andThen(login.cancel, Deferred.await(attempt.settled)),
            ),
          );
        }),
      ),
    );
    return yield* profiles(provider);
  });
  /** Done once the provider's running login, if any, has finished either way. */
  const settled = (provider: OAuthProvider) =>
    Effect.flatMap(activeAttempt(provider), (attempt) =>
      Effect.transposeOption(Option.map(attempt, (running) => Deferred.await(running.settled))),
    ).pipe(Effect.asVoid);
  return { profiles, start, cancel, settled };
});

/** One pending OAuth callback per provider for the app's profile store. */
export class OAuthAccountLogins extends Context.Service<
  OAuthAccountLogins,
  Effect.Success<ReturnType<typeof createOAuthAccountLoginManager>>
>()("memory-agent/oauth/account-login/OAuthAccountLogins") {
  static readonly layer = Layer.effect(
    OAuthAccountLogins,
    Effect.flatMap(Effect.service(OAuthProfiles), (profiles) =>
      createOAuthAccountLoginManager({ profiles }),
    ),
  );
}
