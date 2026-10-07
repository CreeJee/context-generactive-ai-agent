import { Cause, Effect, MutableHashMap, Option, Result, Schema } from "effect";
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

const call = Effect.fn("credentialSdkCall")(<A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) }),
);
const rejects = Effect.fn("credentialSdkRejects")(function* <A>(
  operation: () => Promise<A>,
  message: string,
) {
  const outcome = yield* Effect.result(call(operation));
  Result.match(outcome, {
    onFailure: (error) =>
      expect(() => {
        throw error.cause;
      }).toThrow(message),
    onSuccess: () => expect.fail("Expected the credential operation to reject"),
  });
});

function vault() {
  const values = MutableHashMap.empty<string, string>();
  let rejectedAccount: string | null = null;
  let fragmentWritesBeforeFailure: number | null = null;
  const open = (account: string): PasswordEntry => ({
    getPassword() {
      return Promise.resolve(Option.getOrUndefined(MutableHashMap.get(values, account)) ?? null);
    },
    setPassword(password) {
      return Promise.resolve().then(() => {
        if (Buffer.byteLength(password, "utf16le") > 2_560)
          throw new Error("Windows credential blob limit exceeded.");
        if (account === rejectedAccount) throw new Error("Synthetic write failure.");
        if (account !== "subscription-oauth" && fragmentWritesBeforeFailure !== null) {
          if (fragmentWritesBeforeFailure === 0) throw new Error("Synthetic fragment failure.");
          fragmentWritesBeforeFailure--;
        }
        MutableHashMap.set(values, account, password);
      });
    },
    deleteCredential() {
      const present = MutableHashMap.has(values, account);
      MutableHashMap.remove(values, account);
      return Promise.resolve(present);
    },
  });
  return {
    values,
    open,
    entry: () => createChunkedPasswordEntry(open, "subscription-oauth"),
    failRootWrite: () => {
      rejectedAccount = "subscription-oauth";
    },
    failFragmentWrite: () => {
      fragmentWritesBeforeFailure = 1;
    },
  };
}

it.live("treats a native null result as a signed-out credential store", () =>
  Effect.gen(function* () {
    const storage = vault();
    const store = createKeychainCredentialStore(() => storage.open("subscription-oauth"));
    expect(yield* call(() => store.read("openai"))).toBeNull();
    const client = createSubscriptionOAuthClient({ protocol: providerProtocols.openai, store });
    expect((yield* call(() => client.status())).connected).toBe(false);
    expect(yield* call(() => storage.entry().getPassword())).toBeUndefined();
  }),
);

it.live(
  "round-trips a long OpenAI credential across fresh vault entries within the Windows limit",
  () =>
    Effect.gen(function* () {
      const storage = vault();
      const credential = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        accessToken: "access".repeat(800),
        refreshToken: "refresh".repeat(300),
        idToken: "identity".repeat(500),
        accountId: "synthetic-account",
        expiresAt: 123_456,
      });
      yield* rejects(() => storage.open("subscription-oauth").setPassword(credential), "limit");
      yield* call(() => storage.entry().setPassword(credential));
      expect(yield* call(() => storage.entry().getPassword())).toBe(credential);
      expect(MutableHashMap.size(storage.values)).toBeGreaterThan(2);
      for (const value of MutableHashMap.values(storage.values))
        expect(Buffer.byteLength(value, "utf16le")).toBeLessThanOrEqual(2_560);
      yield* call(() => storage.entry().deleteCredential());
      expect(MutableHashMap.size(storage.values)).toBe(0);
      expect(yield* call(() => storage.entry().getPassword())).toBeUndefined();
      expect(yield* call(() => storage.entry().deleteCredential())).toBe(false);
    }),
);

it.live("preserves existing unchunked credentials and the exact 1,280 character boundary", () =>
  Effect.gen(function* () {
    const storage = vault();
    MutableHashMap.set(storage.values, "subscription-oauth", '{"accessToken":"legacy"}');
    expect(yield* call(() => storage.entry().getPassword())).toBe('{"accessToken":"legacy"}');
    for (const length of [1_280, 1_281]) {
      const password = "x".repeat(length);
      yield* call(() => storage.entry().setPassword(password));
      expect(yield* call(() => storage.entry().getPassword())).toBe(password);
      expect(MutableHashMap.size(storage.values)).toBe(length === 1_280 ? 1 : 3);
    }
  }),
);

it.live(
  "cleans up retired fragments on refresh and when replacing a long credential with a short one",
  () =>
    Effect.gen(function* () {
      const storage = vault();
      yield* call(() => storage.entry().setPassword("old".repeat(3_000)));
      const oldAccounts = Array.from(MutableHashMap.keys(storage.values)).filter(
        (key) => key !== "subscription-oauth",
      );
      yield* call(() => storage.entry().setPassword("new".repeat(1_000)));
      expect(yield* call(() => storage.entry().getPassword())).toBe("new".repeat(1_000));
      for (const account of oldAccounts)
        expect(MutableHashMap.has(storage.values, account)).toBe(false);
      yield* call(() => storage.entry().setPassword("short"));
      expect(Array.from(storage.values)).toEqual([["subscription-oauth", "short"]]);
    }),
);

it.live.each(["fragment", "manifest"] as const)(
  "keeps the previous credential and removes staged fragments after a failed %s write",
  (stage) =>
    Effect.gen(function* () {
      const storage = vault();
      const password = "previous".repeat(600);
      yield* call(() => storage.entry().setPassword(password));
      const previous = Array.from(storage.values);
      if (stage === "fragment") storage.failFragmentWrite();
      else storage.failRootWrite();
      yield* rejects(() => storage.entry().setPassword("replacement".repeat(500)), "Synthetic");
      expect(yield* call(() => storage.entry().getPassword())).toBe(password);
      expect(Array.from(storage.values)).toEqual(previous);
    }),
);

it.live("rejects missing or corrupted fragments instead of returning partial credentials", () =>
  Effect.gen(function* () {
    for (const corruption of ["missing", "changed"] as const) {
      const storage = vault();
      yield* call(() => storage.entry().setPassword("credential".repeat(400)));
      const account = Array.from(MutableHashMap.keys(storage.values)).find(
        (key) => key !== "subscription-oauth",
      )!;
      if (corruption === "missing") MutableHashMap.remove(storage.values, account);
      else MutableHashMap.set(storage.values, account, "corrupted");
      yield* rejects(() => storage.entry().getPassword(), "Incomplete");
    }
  }),
);

it.live("rejects malformed manifests and excessive fragment counts", () =>
  Effect.gen(function* () {
    const storage = vault();
    MutableHashMap.set(
      storage.values,
      "subscription-oauth",
      "context-agent:chunked-password:v1:{}",
    );
    yield* rejects(() => storage.entry().getPassword(), "Invalid credential manifest");
    MutableHashMap.clear(storage.values);
    yield* rejects(
      () => storage.entry().setPassword("x".repeat(1_280 * 256 + 1)),
      "fragment limit",
    );
    expect(MutableHashMap.size(storage.values)).toBe(0);
  }),
);

it.live("preserves Unicode credentials across ASCII fragments", () =>
  Effect.gen(function* () {
    const storage = vault();
    const password = "x".repeat(1_279) + "😀유원범".repeat(500);
    yield* call(() => storage.entry().setPassword(password));
    expect(yield* call(() => storage.entry().getPassword())).toBe(password);
  }),
);

it.live(
  "completes OpenAI login, refresh and logout with long vault credentials without a proxy attempt",
  () =>
    Effect.gen(function* () {
      const storage = vault();
      const store = createKeychainCredentialStore(() => storage.entry());
      let tokenRequests = 0;
      let proxyAttempts = 0;
      const client = createSubscriptionOAuthClient({
        protocol: { ...providerProtocols.openai, callbackPort: null },
        store,
        fetch: () => {
          tokenRequests++;
          return Promise.resolve(
            Response.json({
              access_token: `access-${tokenRequests}-` + "x".repeat(4_000),
              refresh_token: `refresh-${tokenRequests}-` + "y".repeat(2_000),
              id_token: "z".repeat(3_000),
              expires_in: 3_600,
            }),
          );
        },
        tokenProxyFetch: () => {
          proxyAttempts++;
          return Promise.reject(
            new Error("Proxy must not be used for successful direct requests."),
          );
        },
      });
      const attempt = yield* call(() => client.startLogin({ timeoutMs: 5_000 }));
      yield* Effect.addFinalizer(() => Effect.sync(() => attempt.cancel()));
      const completion = attempt.completed;
      void completion.catch(() => {});
      try {
        const authorization = new URL(attempt.authorizationUrl);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "synthetic-code");
        // The OAuth SDK owns this native loopback callback protocol. Keep its transport at
        // the Promise boundary while the test Fiber owns awaiting and cancellation.
        expect((yield* call(() => fetch(callback))).status).toBe(200);
        expect((yield* call(() => completion)).connected).toBe(true);
        expect((yield* call(() => client.refreshForValidation())).connected).toBe(true);
        expect((yield* call(() => store.read("openai")))?.accessToken).toContain("access-2-");
        expect(tokenRequests).toBe(2);
        expect(proxyAttempts).toBe(0);
        expect((yield* call(() => client.disconnect())).connected).toBe(false);
        expect(MutableHashMap.size(storage.values)).toBe(0);
      } finally {
        attempt.cancel();
      }
    }),
);
