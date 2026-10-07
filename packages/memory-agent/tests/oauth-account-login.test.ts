import { it } from "@effect/vitest";
import { waitUntil } from "./support/wait-until.ts";
import { Cause, Clock, Deferred, Effect, Fiber, MutableHashMap, Option } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, vi } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";
import { createOAuthAccountLoginManager } from "../src/oauth/account-login.ts";
import { createProfileCredentialStore, importLegacyOAuthProfile } from "../src/oauth/accounts.ts";
import { providerProtocols, type OAuthProvider } from "../src/oauth/protocol.ts";
import { createSubscriptionOAuthClient } from "../src/oauth/validation-harness.ts";
import type {
  CredentialStore,
  LoginAttempt,
  StoredCredential,
} from "../src/oauth/validation-harness.ts";

const sdkCall = Effect.fn("oauthLoginTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const oauthSchema = migrations
  .filter(
    (sql) =>
      sql.includes("CREATE TABLE oauth_profiles (") ||
      sql.includes("CREATE TABLE oauth_legacy_removed ("),
  )
  .join("\n");
const credential = (suffix: string): StoredCredential => ({
  accessToken: `access-${suffix}`,
  refreshToken: `refresh-${suffix}`,
  expiresAt: 1000,
});
const fixture = Effect.fn("oauthLoginTest.fixture")(function* () {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) =>
      Effect.sync(() => {
        if (db.isOpen) db.close();
      }),
  );
  const scope = yield* Effect.scope;
  const runNative = Effect.runPromiseWith(yield* Effect.context());
  const clock = yield* Clock.Clock;
  db.exec(oauthSchema);
  const slots = MutableHashMap.empty<string, StoredCredential>();
  const accounts = createProfileCredentialStore((id) => ({
    read: (provider) =>
      Promise.resolve(
        Option.getOrUndefined(MutableHashMap.get(slots, `${provider}:${id}`)) ?? null,
      ),
    write: (provider, value) =>
      Promise.resolve().then(() => {
        MutableHashMap.set(slots, `${provider}:${id}`, value);
      }),
    remove: (provider) =>
      Promise.resolve().then(() => {
        MutableHashMap.remove(slots, `${provider}:${id}`);
      }),
  }));
  const legacy = MutableHashMap.empty<OAuthProvider, StoredCredential>();
  const legacyStore: CredentialStore = {
    read: (provider) =>
      Promise.resolve(Option.getOrUndefined(MutableHashMap.get(legacy, provider)) ?? null),
    write: (provider, value) =>
      Promise.resolve().then(() => {
        MutableHashMap.set(legacy, provider, value);
      }),
    remove: (provider) =>
      Promise.resolve().then(() => {
        MutableHashMap.remove(legacy, provider);
      }),
  };
  const attempts = MutableHashMap.empty<
    OAuthProvider,
    { id: string; succeed(): void; fail(): void }
  >();
  const start = (provider: OAuthProvider, id: string): Promise<LoginAttempt> =>
    Promise.resolve().then(() => {
      const done = Deferred.makeUnsafe<
        { provider: OAuthProvider; connected: boolean; expiresAt: number },
        Error
      >();
      const completed = runNative(
        Deferred.await(done).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
      );
      const succeed = () => {
        Deferred.doneUnsafe(
          done,
          Effect.succeed({
            provider,
            connected: true,
            expiresAt: clock.currentTimeMillisUnsafe() + 60000,
          }),
        );
      };
      const fail = () => {
        Deferred.doneUnsafe(done, Effect.fail(new Cause.UnknownError(new Error("cancelled"))));
      };
      MutableHashMap.set(attempts, provider, { id, succeed, fail });
      return {
        provider,
        authorizationUrl: `https://login.example/${provider}`,
        completed,
        cancel: fail,
      };
    });
  return {
    db,
    accounts,
    slots,
    legacy,
    legacyStore,
    attempts,
    manager: createOAuthAccountLoginManager(db, accounts, start),
  };
});

describe("multi-account OAuth login manager", () => {
  it.live.each(["openai", "anthropic"] as const)(
    "%s production callback admits one exchange and publishes one selected profile",
    (provider) =>
      Effect.gen(function* () {
        const { db, accounts, slots } = yield* fixture();
        const gate = yield* Deferred.make<void>();
        const exchanging = yield* Deferred.make<void>();
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const release = () => Deferred.doneUnsafe(gate, Effect.void);
        let writes = 0;
        const tokenFetch = vi.fn(() =>
          runNative(
            Effect.gen(function* () {
              yield* Deferred.succeed(exchanging, undefined);
              yield* Deferred.await(gate);
              return Response.json({
                access_token: "access-new",
                refresh_token: "refresh-new",
                expires_in: 3600,
              });
            }),
          ),
        );
        let login!: LoginAttempt;
        const manager = createOAuthAccountLoginManager(db, accounts, (p, id) =>
          createSubscriptionOAuthClient({
            protocol: {
              ...providerProtocols[p],
              callbackPort: null,
              callbackRedirectHost: "127.0.0.1",
            },
            fetch: tokenFetch,
            store: {
              read: () => accounts.read(p, id),
              write: (_, value) => {
                writes += 1;
                return accounts.write(p, id, value);
              },
              remove: () => accounts.remove(p, id),
            },
          })
            .startLogin()
            .then((attempt) => {
              login = attempt;
              return attempt;
            }),
        );
        let first: Promise<Response> | undefined;
        try {
          const pending = yield* sdkCall(() => manager.start(provider, "concurrent profile"));
          const authorize = new URL(pending.login.authorizationUrl!);
          const callback = new URL(authorize.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "first-code");
          callback.searchParams.set("state", authorize.searchParams.get("state")!);
          const initiated = fetch(callback);
          first = initiated;
          yield* Deferred.await(exchanging);
          for (const [code, state] of [
            ["first-code", authorize.searchParams.get("state")!],
            ["second-code", authorize.searchParams.get("state")!],
            ["second-code", "wrong-state"],
          ]) {
            const duplicate = new URL(callback);
            duplicate.searchParams.set("code", code!);
            duplicate.searchParams.set("state", state!);
            const rejected = yield* sdkCall(() => fetch(duplicate));
            expect(rejected.status).toBe(410);
            yield* sdkCall(() => rejected.text());
          }
          expect(tokenFetch).toHaveBeenCalledTimes(1);
          expect(writes).toBe(0);
          expect(manager.profiles(provider).profiles).toEqual([]);
          release();
          const response = yield* sdkCall(() => initiated);
          expect(response.status).toBe(200);
          yield* sdkCall(() => response.text());
          yield* sdkCall(() => login.completed);
          yield* waitUntil(
            () => manager.profiles(provider).login.status === "completed",
            "login completion",
            1000,
          );
          expect(writes).toBe(1);
          expect(MutableHashMap.size(slots)).toBe(1);
          expect(manager.profiles(provider).profiles).toEqual([
            expect.objectContaining({ label: "concurrent profile", selected: true }),
          ]);
          expect(tokenFetch).toHaveBeenCalledTimes(1);
        } finally {
          release();
          yield* sdkCall(() => first?.then((response) => response.text()).catch(() => {}));
          yield* sdkCall(() => manager.cancel(provider));
          db.close();
        }
      }),
  );
  it.live.each(["openai", "anthropic"] as const)(
    "%s adds two accounts without changing the legacy active slot",
    (provider) =>
      Effect.gen(function* () {
        const { db, accounts, slots, legacy, legacyStore, attempts, manager } = yield* fixture();
        try {
          yield* sdkCall(() => legacyStore.write(provider, credential("original")));
          yield* sdkCall(() => importLegacyOAuthProfile(db, provider, accounts, legacyStore));
          for (const suffix of [1, 2]) {
            const pending = yield* sdkCall(() => manager.start(provider, `계정 ${suffix}`));
            expect(pending.login).toMatchObject({ status: "pending" });
            const attempt = Option.getOrUndefined(MutableHashMap.get(attempts, provider))!;
            yield* sdkCall(() =>
              accounts.write(provider, attempt.id, credential(`${provider}-${suffix}`)),
            );
            attempt.succeed();
            yield* waitUntil(
              () => manager.profiles(provider).login.status === "completed",
              "login completion",
              1000,
            );
          }
          expect(
            manager
              .profiles(provider)
              .profiles.map((profile) => profile.label)
              .sort(),
          ).toEqual(
            [
              `${provider === "openai" ? "ChatGPT" : "Claude"} (이전 계정)`,
              "계정 1",
              "계정 2",
            ].sort(),
          );
          expect(
            manager
              .profiles(provider)
              .profiles.filter((p) => p.selected)
              .map((p) => p.id),
          ).toEqual([`legacy-${provider}`]);
          expect(Option.getOrUndefined(MutableHashMap.get(legacy, provider))).toEqual(
            credential("original"),
          );
          expect(MutableHashMap.size(slots)).toBe(3);
        } finally {
          db.close();
        }
      }),
  );

  it.live("cancel discards only the pending slot and retains other accounts", () =>
    Effect.gen(function* () {
      const { db, accounts, legacyStore, attempts, manager } = yield* fixture();
      try {
        yield* sdkCall(() => legacyStore.write("openai", credential("original")));
        yield* sdkCall(() => importLegacyOAuthProfile(db, "openai", accounts, legacyStore));
        yield* sdkCall(() => manager.start("openai", "new account"));
        const attempt = Option.getOrUndefined(MutableHashMap.get(attempts, "openai"))!;
        yield* sdkCall(() => accounts.write("openai", attempt.id, credential("new")));
        yield* sdkCall(() =>
          expect(manager.start("openai", "overlap")).rejects.toThrow("oauth_login_in_progress"),
        );
        yield* sdkCall(() => manager.cancel("openai"));
        expect(yield* sdkCall(() => accounts.read("openai", attempt.id))).toBeNull();
        expect(manager.profiles("openai").profiles.map((p) => p.id)).toEqual(["legacy-openai"]);
        expect(yield* sdkCall(() => legacyStore.read("openai"))).toEqual(credential("original"));
      } finally {
        db.close();
      }
    }),
  );
});
