import { testHttpClient } from "./support/http.ts";
import { it } from "@effect/vitest";
import { waitUntil } from "./support/wait-until.ts";
import {
  Clock,
  Context,
  type Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  MutableHashMap,
  MutableRef,
  Option,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { describe, expect, vi } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { AccountLoginState, createOAuthAccountLoginManager } from "../src/oauth/account-login.ts";
import { createProfileCredentialStore, OAuthProfiles } from "../src/oauth/accounts.ts";
import { providerProtocols, type OAuthProvider } from "../src/oauth/protocol.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type LoginAttempt,
  type OAuthConnectionStatus,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import { withOAuthTestPlatform } from "./support/platform.ts";

const credential = (suffix: string): StoredCredential => ({
  accessToken: `access-${suffix}`,
  refreshToken: `refresh-${suffix}`,
  expiresAt: 1000,
});
const fixture = Effect.fn("oauthLoginTest.fixture")(function* () {
  const profiles = Context.get(
    yield* Layer.build(OAuthProfiles.layer.pipe(Layer.provide(Database.layer(":memory:")))),
    OAuthProfiles,
  );
  const slots = MutableHashMap.empty<string, StoredCredential>();
  /** The keychain slot of one profile. */
  const slot = (id: string): CredentialStore => ({
    read: (provider) =>
      Effect.sync(() => Option.getOrNull(MutableHashMap.get(slots, `${provider}:${id}`))),
    write: (provider, value) =>
      Effect.sync(() => {
        MutableHashMap.set(slots, `${provider}:${id}`, value);
      }),
    remove: (provider) =>
      Effect.sync(() => {
        MutableHashMap.remove(slots, `${provider}:${id}`);
      }),
  });
  const accounts = createProfileCredentialStore((id) => Effect.succeed(slot(id)));
  const legacy = MutableHashMap.empty<OAuthProvider, StoredCredential>();
  const legacyStore: CredentialStore = {
    read: (provider) => Effect.sync(() => Option.getOrNull(MutableHashMap.get(legacy, provider))),
    write: (provider, value) =>
      Effect.sync(() => {
        MutableHashMap.set(legacy, provider, value);
      }),
    remove: (provider) =>
      Effect.sync(() => {
        MutableHashMap.remove(legacy, provider);
      }),
  };
  const attempts = MutableHashMap.empty<
    OAuthProvider,
    { id: string; succeed: Effect.Effect<void>; fail: Effect.Effect<void> }
  >();
  const start = Effect.fnUntraced(function* (provider: OAuthProvider, id: string) {
    const done = yield* Deferred.make<OAuthConnectionStatus, OAuthHarnessError>();
    const succeed = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Deferred.succeed(done, { provider, connected: true, expiresAt: now + 60000 }),
    ).pipe(Effect.asVoid);
    const fail = Effect.asVoid(Deferred.fail(done, OAuthHarnessError.fromCode("cancelled")));
    MutableHashMap.set(attempts, provider, { id, succeed, fail });
    const attempt: LoginAttempt = {
      provider,
      authorizationUrl: `https://login.example/${provider}`,
      completed: Deferred.await(done),
      cancel: fail,
    };
    return attempt;
  });
  return {
    profiles,
    accounts,
    slot,
    slots,
    legacy,
    legacyStore,
    attempts,
    manager: yield* createOAuthAccountLoginManager({ profiles, accounts, startLogin: start }),
  };
});

/** The authorization URL of a login waiting for the browser. */
const authorizationUrl = (login: AccountLoginState) =>
  AccountLoginState.$is("pending")(login) ? login.authorizationUrl : undefined;

describe("multi-account OAuth login manager", () => {
  it.live.each(["openai", "anthropic"] as const)(
    "%s production callback admits one exchange and publishes one selected profile",
    (provider) =>
      Effect.gen(function* () {
        const { profiles, accounts, slot, slots } = yield* fixture();
        const platform = yield* Effect.context<
          Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
        >();
        const gate = yield* Deferred.make<void>();
        const exchanging = yield* Deferred.make<void>();
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const writes = MutableRef.make(0);
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
        const manager = yield* createOAuthAccountLoginManager({
          profiles,
          accounts: accounts,
          startLogin: (p, id) =>
            createSubscriptionOAuthClient({
              protocol: {
                ...providerProtocols[p],
                callbackPort: null,
                callbackRedirectHost: "127.0.0.1",
              },
              fetch: tokenFetch,
              store: {
                ...slot(id),
                write: (key, value) =>
                  Effect.suspend(() => {
                    MutableRef.increment(writes);
                    return slot(id).write(key, value);
                  }),
              },
            }).pipe(
              Effect.flatMap((client) => client.startLogin()),
              Effect.provideContext(platform),
            ),
        });
        yield* Effect.addFinalizer(() => Effect.ignore(manager.cancel(provider)));
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const pending = yield* manager.start(provider, "concurrent profile");
        const authorize = new URL(authorizationUrl(pending.login)!);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "first-code");
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        const initiated = yield* Effect.forkChild(
          (yield* testHttpClient()).get(callback.toString()),
          { startImmediately: true },
        );
        yield* Deferred.await(exchanging);
        yield* Effect.forEach(
          [
            ["first-code", authorize.searchParams.get("state")!],
            ["second-code", authorize.searchParams.get("state")!],
            ["second-code", "wrong-state"],
          ],
          Effect.fnUntraced(function* ([code, state]) {
            const duplicate = new URL(callback);
            duplicate.searchParams.set("code", code!);
            duplicate.searchParams.set("state", state!);
            const rejected = yield* (yield* testHttpClient()).get(duplicate.toString());
            expect(rejected.status).toBe(410);
            yield* rejected.text;
          }),
          { discard: true },
        );
        expect(tokenFetch).toHaveBeenCalledTimes(1);
        expect(MutableRef.get(writes)).toBe(0);
        expect((yield* manager.profiles(provider)).profiles).toEqual([]);
        yield* Deferred.succeed(gate, undefined);
        const response = yield* Fiber.join(initiated);
        expect(response.status).toBe(200);
        yield* response.text;
        yield* manager.settled(provider);
        yield* waitUntil(
          Effect.map(manager.profiles(provider), (state) =>
            AccountLoginState.$is("completed")(state.login),
          ),
          "login completion",
          1000,
        );
        expect(MutableRef.get(writes)).toBe(1);
        expect(MutableHashMap.size(slots)).toBe(1);
        expect((yield* manager.profiles(provider)).profiles).toEqual([
          expect.objectContaining({ label: "concurrent profile", selected: true }),
        ]);
        expect(tokenFetch).toHaveBeenCalledTimes(1);
      }).pipe(withOAuthTestPlatform),
  );
  it.live.each(["openai", "anthropic"] as const)(
    "%s adds two accounts without changing the legacy active slot",
    (provider) =>
      Effect.gen(function* () {
        const { profiles, accounts, slots, legacy, legacyStore, attempts, manager } =
          yield* fixture();
        yield* legacyStore.write(provider, credential("original"));
        yield* profiles.importLegacy(provider, accounts, legacyStore);
        yield* Effect.forEach(
          [1, 2],
          Effect.fnUntraced(function* (suffix) {
            const pending = yield* manager.start(provider, `계정 ${suffix}`);
            expect(AccountLoginState.$is("pending")(pending.login)).toBe(true);
            const attempt = Option.getOrUndefined(MutableHashMap.get(attempts, provider))!;
            yield* accounts.write(provider, attempt.id, credential(`${provider}-${suffix}`));
            yield* attempt.succeed;
            yield* waitUntil(
              Effect.map(manager.profiles(provider), (state) =>
                AccountLoginState.$is("completed")(state.login),
              ),
              "login completion",
              1000,
            );
          }),
          { discard: true },
        );
        expect(
          (yield* manager.profiles(provider)).profiles.map((profile) => profile.label).sort(),
        ).toEqual(
          [
            `${provider === "openai" ? "ChatGPT" : "Claude"} (이전 계정)`,
            "계정 1",
            "계정 2",
          ].sort(),
        );
        expect(
          (yield* manager.profiles(provider)).profiles.filter((p) => p.selected).map((p) => p.id),
        ).toEqual([`legacy-${provider}`]);
        expect(Option.getOrUndefined(MutableHashMap.get(legacy, provider))).toEqual(
          credential("original"),
        );
        expect(MutableHashMap.size(slots)).toBe(3);
      }).pipe(withOAuthTestPlatform),
  );

  it.live("cancel discards only the pending slot and retains other accounts", () =>
    Effect.gen(function* () {
      const { profiles, accounts, legacyStore, attempts, manager } = yield* fixture();
      yield* legacyStore.write("openai", credential("original"));
      yield* profiles.importLegacy("openai", accounts, legacyStore);
      yield* manager.start("openai", "new account");
      const attempt = Option.getOrUndefined(MutableHashMap.get(attempts, "openai"))!;
      yield* accounts.write("openai", attempt.id, credential("new"));
      expect((yield* Effect.flip(manager.start("openai", "overlap"))).message).toContain(
        "oauth_login_in_progress",
      );
      yield* manager.cancel("openai");
      expect(yield* accounts.read("openai", attempt.id)).toBeNull();
      expect((yield* manager.profiles("openai")).profiles.map((p) => p.id)).toEqual([
        "legacy-openai",
      ]);
      expect(yield* legacyStore.read("openai")).toEqual(credential("original"));
    }).pipe(withOAuthTestPlatform),
  );
});
