import { testHttpClient } from "./support/http.ts";
import { Cause, Data, Effect, MutableHashMap, MutableRef, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  createKeychainCredentialStore,
  createSubscriptionOAuthClient,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import {
  createChunkedPasswordEntry,
  type PasswordEntry,
} from "../src/oauth/chunked-password-entry.ts";
import { withOAuthTestPlatform, withTestPlatform } from "./support/platform.ts";

/** A vault operation the synthetic vault refused. */
class VaultRejected extends Data.TaggedError("VaultRejected")<{ readonly message: string }> {}

const rejects = Effect.fn("credentialRejects")(function* <
  A,
  E extends { readonly message: string },
>(operation: Effect.Effect<A, E>, message: string) {
  expect((yield* Effect.flip(operation)).message).toContain(message);
});

function vault() {
  const values = MutableHashMap.empty<string, string>();
  const rejectedAccount = MutableRef.make<string | null>(null);
  const fragmentWritesBeforeFailure = MutableRef.make<number | null>(null);
  const refused = (message: string) => Effect.fail(new VaultRejected({ message }));
  const open = (account: string): PasswordEntry<VaultRejected> => ({
    getPassword: Effect.sync(() => Option.getOrNull(MutableHashMap.get(values, account))),
    setPassword: (password) =>
      Effect.suspend(() => {
        if (Buffer.byteLength(password, "utf16le") > 2_560)
          return refused("Windows credential blob limit exceeded.");
        if (account === MutableRef.get(rejectedAccount)) return refused("Synthetic write failure.");
        const fragmentWrites = MutableRef.get(fragmentWritesBeforeFailure);
        if (account !== "subscription-oauth" && fragmentWrites !== null) {
          if (fragmentWrites === 0) return refused("Synthetic fragment failure.");
          MutableRef.set(fragmentWritesBeforeFailure, fragmentWrites - 1);
        }
        MutableHashMap.set(values, account, password);
        return Effect.void;
      }),
    deleteCredential: Effect.sync(() => {
      const present = MutableHashMap.has(values, account);
      MutableHashMap.remove(values, account);
      return present;
    }),
  });
  return {
    values,
    open,
    entry: createChunkedPasswordEntry({
      open: (account) => Effect.succeed(open(account)),
      account: "subscription-oauth",
    }),
    failRootWrite: () => {
      MutableRef.set(rejectedAccount, "subscription-oauth");
    },
    failFragmentWrite: () => {
      MutableRef.set(fragmentWritesBeforeFailure, 1);
    },
  };
}

it.live("treats a native null result as a signed-out credential store", () =>
  Effect.gen(function* () {
    const storage = vault();
    const store = createKeychainCredentialStore(() =>
      Effect.succeed(storage.open("subscription-oauth")),
    );
    expect(yield* store.read("openai")).toBeNull();
    const client = yield* createSubscriptionOAuthClient({
      protocol: providerProtocols.openai,
      store,
    });
    expect((yield* client.status).connected).toBe(false);
    expect(yield* (yield* storage.entry).getPassword).toBeNull();
  }).pipe(withOAuthTestPlatform),
);

it.live(
  "round-trips a long OpenAI credential across fresh vault entries within the Windows limit",
  () =>
    Effect.gen(function* () {
      const storage = vault();
      const entry = yield* storage.entry;
      const credential = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        accessToken: "access".repeat(800),
        refreshToken: "refresh".repeat(300),
        idToken: "identity".repeat(500),
        accountId: "synthetic-account",
        expiresAt: 123_456,
      });
      yield* rejects(storage.open("subscription-oauth").setPassword(credential), "limit");
      yield* entry.setPassword(credential);
      expect(yield* entry.getPassword).toBe(credential);
      expect(MutableHashMap.size(storage.values)).toBeGreaterThan(2);
      Array.from(MutableHashMap.values(storage.values)).forEach((value) =>
        expect(Buffer.byteLength(value, "utf16le")).toBeLessThanOrEqual(2_560),
      );
      yield* entry.deleteCredential;
      expect(MutableHashMap.size(storage.values)).toBe(0);
      expect(yield* entry.getPassword).toBeNull();
      expect(yield* entry.deleteCredential).toBe(false);
    }).pipe(withTestPlatform),
);

it.live("preserves existing unchunked credentials and the exact 1,280 character boundary", () =>
  Effect.gen(function* () {
    const storage = vault();
    const entry = yield* storage.entry;
    MutableHashMap.set(storage.values, "subscription-oauth", '{"accessToken":"legacy"}');
    expect(yield* entry.getPassword).toBe('{"accessToken":"legacy"}');
    yield* Effect.forEach(
      [1_280, 1_281],
      Effect.fnUntraced(function* (length) {
        const password = "x".repeat(length);
        yield* entry.setPassword(password);
        expect(yield* entry.getPassword).toBe(password);
        expect(MutableHashMap.size(storage.values)).toBe(length === 1_280 ? 1 : 3);
      }),
      { discard: true },
    );
  }).pipe(withTestPlatform),
);

it.live(
  "cleans up retired fragments on refresh and when replacing a long credential with a short one",
  () =>
    Effect.gen(function* () {
      const storage = vault();
      const entry = yield* storage.entry;
      yield* entry.setPassword("old".repeat(3_000));
      const oldAccounts = Array.from(MutableHashMap.keys(storage.values)).filter(
        (key) => key !== "subscription-oauth",
      );
      yield* entry.setPassword("new".repeat(1_000));
      expect(yield* entry.getPassword).toBe("new".repeat(1_000));
      oldAccounts.forEach((account) =>
        expect(MutableHashMap.has(storage.values, account)).toBe(false),
      );
      yield* entry.setPassword("short");
      expect(Array.from(storage.values)).toEqual([["subscription-oauth", "short"]]);
    }).pipe(withTestPlatform),
);

it.live.each(["fragment", "manifest"] as const)(
  "keeps the previous credential and removes staged fragments after a failed %s write",
  (stage) =>
    Effect.gen(function* () {
      const storage = vault();
      const entry = yield* storage.entry;
      const password = "previous".repeat(600);
      yield* entry.setPassword(password);
      const previous = Array.from(storage.values);
      if (stage === "fragment") storage.failFragmentWrite();
      else storage.failRootWrite();
      yield* rejects(entry.setPassword("replacement".repeat(500)), "Synthetic");
      expect(yield* entry.getPassword).toBe(password);
      expect(Array.from(storage.values)).toEqual(previous);
    }).pipe(withTestPlatform),
);

it.live("rejects missing or corrupted fragments instead of returning partial credentials", () =>
  Effect.forEach(
    ["missing", "changed"] as const,
    Effect.fnUntraced(function* (corruption) {
      const storage = vault();
      const entry = yield* storage.entry;
      yield* entry.setPassword("credential".repeat(400));
      const account = Array.from(MutableHashMap.keys(storage.values)).find(
        (key) => key !== "subscription-oauth",
      )!;
      if (corruption === "missing") MutableHashMap.remove(storage.values, account);
      else MutableHashMap.set(storage.values, account, "corrupted");
      yield* rejects(entry.getPassword, "Incomplete");
    }),
    { discard: true },
  ).pipe(withTestPlatform),
);

it.live("rejects malformed manifests and excessive fragment counts", () =>
  Effect.gen(function* () {
    const storage = vault();
    const entry = yield* storage.entry;
    MutableHashMap.set(
      storage.values,
      "subscription-oauth",
      "context-agent:chunked-password:v1:{}",
    );
    yield* rejects(entry.getPassword, "Invalid credential manifest");
    MutableHashMap.clear(storage.values);
    yield* rejects(entry.setPassword("x".repeat(1_280 * 256 + 1)), "fragment limit");
    expect(MutableHashMap.size(storage.values)).toBe(0);
  }).pipe(withTestPlatform),
);

it.live("preserves Unicode credentials across ASCII fragments", () =>
  Effect.gen(function* () {
    const entry = yield* vault().entry;
    const password = "x".repeat(1_279) + "😀유원범".repeat(500);
    yield* entry.setPassword(password);
    expect(yield* entry.getPassword).toBe(password);
  }).pipe(withTestPlatform),
);

it.live(
  "completes OpenAI login, refresh and logout with long vault credentials without a proxy attempt",
  () =>
    Effect.gen(function* () {
      const storage = vault();
      const entry = yield* storage.entry;
      const store = createKeychainCredentialStore(() => Effect.succeed(entry));
      const tokenRequests = MutableRef.make(0);
      const proxyAttempts = MutableRef.make(0);
      const client = yield* createSubscriptionOAuthClient({
        protocol: { ...providerProtocols.openai, callbackPort: null },
        store,
        fetch: () => {
          const request = MutableRef.incrementAndGet(tokenRequests);
          return Promise.resolve(
            Response.json({
              access_token: `access-${request}-` + "x".repeat(4_000),
              refresh_token: `refresh-${request}-` + "y".repeat(2_000),
              id_token: "z".repeat(3_000),
              expires_in: 3_600,
            }),
          );
        },
        tokenProxyFetch: () =>
          Effect.andThen(
            Effect.sync(() => {
              MutableRef.increment(proxyAttempts);
            }),
            Effect.fail(
              new Cause.UnknownError(
                new Error("Proxy must not be used for successful direct requests."),
              ),
            ),
          ),
      });
      const attempt = yield* Effect.acquireRelease(
        client.startLogin({ timeoutMs: 5_000 }),
        (started) => started.cancel,
      );
      const authorization = new URL(attempt.authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code");
      expect((yield* (yield* testHttpClient()).get(callback.toString())).status).toBe(200);
      expect((yield* attempt.completed).connected).toBe(true);
      expect((yield* client.refreshForValidation).connected).toBe(true);
      expect((yield* store.read("openai"))?.accessToken).toContain("access-2-");
      expect(MutableRef.get(tokenRequests)).toBe(2);
      expect(MutableRef.get(proxyAttempts)).toBe(0);
      expect((yield* client.disconnect).connected).toBe(false);
      expect(MutableHashMap.size(storage.values)).toBe(0);
    }).pipe(withOAuthTestPlatform),
);
