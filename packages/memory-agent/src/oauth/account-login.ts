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
    Option.getOrUndefined(
      Option.map(
        Option.filter(MutableHashMap.get(entries, provider), LoginEntry.$is("running")),
        (entry) => entry.attempt,
      ),
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
        if (activeAttempt(provider) !== undefined)
          return yield* OAuthHarnessError.fromCode("login_in_progress");
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
          if (attempt.cancelled) login.cancel();
          // Completion is owned by the login SDK and its explicit cancel callback, across HTTP requests.
          attempt.completed = runOAuthNodeEffect(
            nativePromise(() => login.completed).pipe(
              Effect.flatMap((connection) =>
                Effect.gen(function* () {
                  if (!connection.connected || attempt.cancelled)
                    return yield* OAuthHarnessError.fromCode(
                      attempt.cancelled ? "cancelled" : "not_connected",
                    );
                  yield* store.publish(provider, attempt.id, attempt.label, accounts);
                  if (!(yield* store.list(provider)).some((profile) => profile.selected))
                    yield* store.select(provider, attempt.id, accounts);
                  recordResult(provider, AccountLoginState.completed());
                }),
              ),
              // Any failed completion is the attempt's outcome; the page shows it as login_failed.
              Effect.catch(() =>
                Effect.gen(function* () {
                  if (!(yield* store.list(provider)).some((profile) => profile.id === attempt.id)) {
                    // Best-effort removal of the unpublished slot; the login already failed.
                    yield* nativePromise(() => accounts.remove(provider, attempt.id)).pipe(
                      Effect.catchTag("UnknownError", () =>
                        Effect.logWarning("OAuth login slot cleanup failed", {
                          error: "UnknownError",
                        }),
                      ),
                    );
                    recordResult(provider, AccountLoginState.error({ error: "login_failed" }));
                  } else recordResult(provider, AccountLoginState.completed());
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
                  if (LoginEntry.$is("running")(entry) && entry.attempt === attempt)
                    MutableHashMap.set(
                      entries,
                      provider,
                      LoginEntry.settled({ result: entry.result }),
                    );
                }),
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
        const attempt = activeAttempt(provider);
        if (attempt !== undefined) {
          attempt.cancelled = true;
          attempt.login?.cancel();
          const completed = attempt.completed;
          if (completed !== undefined) yield* nativePromise(() => completed);
        }
        return yield* profiles(provider);
      }),
    );
  /** Resolves once the provider's running login, if any, has finished either way. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const settled = (provider: OAuthProvider): Promise<void> =>
    activeAttempt(provider)?.completed ?? Promise.resolve();
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
