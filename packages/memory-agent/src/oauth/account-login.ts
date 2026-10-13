import { nativePromise } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { Cause, Effect, MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import { Crypto } from "effect";
import type { DatabaseSync } from "node:sqlite";
import {
  createProfileCredentialStore,
  listOAuthProfiles,
  publishOAuthProfileEffect,
  selectOAuthProfileEffect,
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
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function createOAuthAccountLoginManager(options: {
  readonly sqlite: DatabaseSync;
  readonly accounts?: ProfileCredentialStore | undefined;
  readonly startLogin?: LoginStarter | undefined;
}) {
  return createOAuthAccountLoginManagerBody(options.sqlite, options.accounts, options.startLogin);
}
function createOAuthAccountLoginManagerBody(
  sqlite: DatabaseSync,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  startLogin: LoginStarter = (provider, id) =>
    createSubscriptionOAuthClient({
      protocol: providerProtocols[provider],
      store: createKeychainProfileCredentialStore(id),
    }).startLogin(),
) {
  type LoginEntry =
    | { readonly status: "running"; readonly attempt: Attempt; result: AccountLoginState }
    | { readonly status: "settled"; readonly result: AccountLoginState };
  const entries = MutableHashMap.empty<OAuthProvider, LoginEntry>();
  const activeAttempt = (provider: OAuthProvider) => {
    const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
    switch (entry?.status) {
      case "running":
        return entry.attempt;
      default:
        return undefined;
    }
  };
  const recordResult = (provider: OAuthProvider, value: AccountLoginState) => {
    const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
    switch (entry?.status) {
      case "running":
        entry.result = value;
        break;
      default:
        MutableHashMap.set(entries, provider, { status: "settled", result: value });
        break;
    }
  };
  const state = (provider: OAuthProvider): AccountLoginState => {
    const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
    switch (entry?.status) {
      case "running":
        return isTruthy(entry.attempt.login)
          ? { status: "pending", authorizationUrl: entry.attempt.login.authorizationUrl }
          : entry.result;
      case "settled":
        return entry.result;
      case undefined:
        return { status: "idle" };
    }
  };
  const profiles = (provider: OAuthProvider) => ({
    profiles: listOAuthProfiles({ sqlite: sqlite, provider: provider }),
    login: state(provider),
  });
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const start = (provider: OAuthProvider, label: string) =>
    runOAuthNodeEffect(
      Effect.gen(function* () {
        if (label.trim().length === 0 || label.length > 80)
          return yield* new Cause.UnknownError(new Error("invalid_oauth_profile"));
        if (activeAttempt(provider) !== undefined)
          return yield* new Cause.UnknownError(new Error("oauth_login_in_progress"));
        const attempt: Attempt = {
          id: yield* (yield* Crypto.Crypto).randomUUIDv4(),
          label: label.trim(),
          cancelled: false,
        };
        MutableHashMap.set(entries, provider, {
          status: "running",
          attempt,
          result: { status: "idle" },
        });
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
                    return yield* new Cause.UnknownError(new Error("login_failed"));
                  yield* publishOAuthProfileEffect(
                    sqlite,
                    provider,
                    attempt.id,
                    attempt.label,
                    accounts,
                  );
                  if (
                    !listOAuthProfiles({ sqlite: sqlite, provider: provider }).some(
                      (profile) => profile.selected,
                    )
                  )
                    yield* selectOAuthProfileEffect(sqlite, provider, attempt.id, accounts);
                  recordResult(provider, { status: "completed" });
                }),
              ),
              Effect.catchCause(() =>
                Effect.gen(function* () {
                  if (
                    !listOAuthProfiles({ sqlite: sqlite, provider: provider }).some(
                      (profile) => profile.id === attempt.id,
                    )
                  ) {
                    yield* nativePromise(() => accounts.remove(provider, attempt.id)).pipe(
                      Effect.ignore,
                    );
                    recordResult(provider, { status: "error", error: "login_failed" });
                  } else recordResult(provider, { status: "completed" });
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  const entry = Option.getOrUndefined(MutableHashMap.get(entries, provider));
                  if (entry?.status === "running" && entry.attempt === attempt)
                    MutableHashMap.set(entries, provider, {
                      status: "settled",
                      result: entry.result,
                    });
                }),
              ),
            ),
          );
          return profiles(provider);
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              MutableHashMap.set(entries, provider, {
                status: "settled",
                result: { status: "error", error: "credential_unavailable" },
              });
              return profiles(provider);
            }),
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
        return profiles(provider);
      }),
    );
  /** Resolves once the provider's running login, if any, has finished either way. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const settled = (provider: OAuthProvider): Promise<void> =>
    activeAttempt(provider)?.completed ?? Promise.resolve();
  return { profiles, start, cancel, settled };
}
