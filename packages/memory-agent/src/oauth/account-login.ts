import { nativePromise } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { Context, Data, Effect, Layer, MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import { Crypto } from "effect";
import {
  createProfileCredentialStore,
  OAuthProfileRejected,
  OAuthProfiles,
  type ProfileCredentialStore,
} from "./accounts.ts";
import { providerProtocols, type OAuthProvider } from "./protocol.ts";
import {
  createKeychainProfileCredentialStore,
  createSubscriptionOAuthClient,
  OAuthHarnessError,
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
/** Where a provider's add-account login stands, as the account page shows it. */
export type AccountLoginState = Data.TaggedEnum<{
  idle: {};
  completed: {};
  pending: { readonly authorizationUrl: string };
  error: { readonly error: "login_failed" | "credential_unavailable" };
}>;
export const AccountLoginState = Data.taggedEnum<AccountLoginState>();

/** Each login gets a fresh keychain slot; the legacy provider client is never used to add accounts. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function createOAuthAccountLoginManager(options: {
  readonly profiles: OAuthProfiles["Service"];
  readonly accounts?: ProfileCredentialStore | undefined;
  readonly startLogin?: LoginStarter | undefined;
}) {
  return createOAuthAccountLoginManagerBody(options.profiles, options.accounts, options.startLogin);
}
function createOAuthAccountLoginManagerBody(
  store: OAuthProfiles["Service"],
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  startLogin: LoginStarter = (provider, id) =>
    createSubscriptionOAuthClient({
      protocol: providerProtocols[provider],
      store: createKeychainProfileCredentialStore(id),
    }).startLogin(),
) {
  type LoginEntry = Data.TaggedEnum<{
    running: { readonly attempt: Attempt; readonly result: AccountLoginState };
    settled: { readonly result: AccountLoginState };
  }>;
  const LoginEntry = Data.taggedEnum<LoginEntry>();
  const entries = MutableHashMap.empty<OAuthProvider, LoginEntry>();
  const activeAttempt = (provider: OAuthProvider) =>
    Option.map(
      Option.filter(MutableHashMap.get(entries, provider), LoginEntry.$is("running")),
      (entry) => entry.attempt,
    );
  const recordResult = (provider: OAuthProvider, value: AccountLoginState) =>
    MutableHashMap.set(
      entries,
      provider,
      Option.match(
        Option.filter(MutableHashMap.get(entries, provider), LoginEntry.$is("running")),
        {
          onNone: () => LoginEntry.settled({ result: value }),
          onSome: (entry) => LoginEntry.running({ attempt: entry.attempt, result: value }),
        },
      ),
    );
  const state = (provider: OAuthProvider): AccountLoginState =>
    Option.match(MutableHashMap.get(entries, provider), {
      onNone: (): AccountLoginState => AccountLoginState.idle(),
      onSome: LoginEntry.$match({
        running: (entry): AccountLoginState =>
          isTruthy(entry.attempt.login)
            ? AccountLoginState.pending({ authorizationUrl: entry.attempt.login.authorizationUrl })
            : entry.result,
        settled: (entry) => entry.result,
      }),
    });
  const profiles = (provider: OAuthProvider) =>
    Effect.map(store.list(provider), (listed) => ({ profiles: listed, login: state(provider) }));
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const start = (provider: OAuthProvider, label: string) =>
    runOAuthNodeEffect(
      Effect.gen(function* () {
        if (label.trim().length === 0 || label.length > 80)
          return yield* OAuthProfileRejected.make({ reason: "invalid_oauth_profile" });
        yield* Effect.when(
          Effect.fail(OAuthHarnessError.fromCode("login_in_progress")),
          Effect.succeed(Option.isSome(activeAttempt(provider))),
        );
        const attempt: Attempt = {
          id: yield* (yield* Crypto.Crypto).randomUUIDv4(),
          label: label.trim(),
          cancelled: false,
        };
        MutableHashMap.set(
          entries,
          provider,
          LoginEntry.running({ attempt, result: AccountLoginState.idle() }),
        );
        return yield* Effect.gen(function* () {
          const login = yield* nativePromise(() => startLogin(provider, attempt.id));
          attempt.login = login;
          yield* Effect.when(
            Effect.sync(() => login.cancel()),
            Effect.succeed(attempt.cancelled),
          );
          // Completion is owned by the login SDK and its explicit cancel callback, across HTTP requests.
          attempt.completed = runOAuthNodeEffect(
            nativePromise(() => login.completed).pipe(
              Effect.flatMap((connection) =>
                Effect.gen(function* () {
                  yield* Effect.when(
                    Effect.fail(OAuthHarnessError.fromCode("cancelled")),
                    Effect.succeed(attempt.cancelled),
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
                  recordResult(provider, AccountLoginState.completed());
                }),
              ),
              // Any failed completion is the attempt's outcome; the page shows it as login_failed.
              Effect.catch(() =>
                Effect.flatMap(store.list(provider), (listed) =>
                  listed.some((profile) => profile.id === attempt.id)
                    ? Effect.sync(() => recordResult(provider, AccountLoginState.completed()))
                    : // Best-effort removal of the unpublished slot; the login already failed.
                      nativePromise(() => accounts.remove(provider, attempt.id)).pipe(
                        Effect.catchTag("UnknownError", () =>
                          Effect.logWarning("OAuth login slot cleanup failed", {
                            error: "UnknownError",
                          }),
                        ),
                        Effect.andThen(
                          Effect.sync(() =>
                            recordResult(
                              provider,
                              AccountLoginState.error({ error: "login_failed" }),
                            ),
                          ),
                        ),
                      ),
                ),
              ),
              Effect.asVoid,
              // Only this attempt's own running entry settles; a newer login keeps its state.
              Effect.ensuring(
                Effect.sync(() =>
                  MutableHashMap.get(entries, provider).pipe(
                    Option.filter(LoginEntry.$is("running")),
                    Option.filter((entry) => entry.attempt === attempt),
                    Option.map((entry) =>
                      MutableHashMap.set(
                        entries,
                        provider,
                        LoginEntry.settled({ result: entry.result }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          return yield* profiles(provider);
        }).pipe(
          // A login that cannot start leaves the provider's accounts as they were.
          Effect.catch(() =>
            Effect.sync(() =>
              MutableHashMap.set(
                entries,
                provider,
                LoginEntry.settled({
                  result: AccountLoginState.error({ error: "credential_unavailable" }),
                }),
              ),
            ).pipe(Effect.andThen(profiles(provider))),
          ),
        );
      }),
    );
  const cancel = (provider: OAuthProvider) =>
    runOAuthNodeEffect(
      Effect.gen(function* () {
        yield* Option.match(activeAttempt(provider), {
          onNone: () => Effect.void,
          onSome: (attempt) => {
            attempt.cancelled = true;
            attempt.login?.cancel();
            // A login still starting has no completion yet; its start sees the flag instead.
            return nativePromise(() => attempt.completed ?? Promise.resolve());
          },
        });
        return yield* profiles(provider);
      }),
    );
  /** Resolves once the provider's running login, if any, has finished either way. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const settled = (provider: OAuthProvider): Promise<void> =>
    Option.getOrElse(
      Option.flatMapNullishOr(activeAttempt(provider), (attempt) => attempt.completed),
      () => Promise.resolve(),
    );
  return { profiles, start, cancel, settled };
}

/** One pending OAuth callback per provider for the app's profile store. */
export class OAuthAccountLogins extends Context.Service<
  OAuthAccountLogins,
  ReturnType<typeof createOAuthAccountLoginManager>
>()("memory-agent/oauth/account-login/OAuthAccountLogins") {
  static readonly layer = Layer.effect(
    OAuthAccountLogins,
    Effect.gen(function* () {
      return createOAuthAccountLoginManager({ profiles: yield* OAuthProfiles });
    }),
  );
}
