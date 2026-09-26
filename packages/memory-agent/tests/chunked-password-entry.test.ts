import { expect, test } from "vite-plus/test";
import {
  createKeychainCredentialStore,
  createSubscriptionOAuthClient,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import {
  createChunkedPasswordEntry,
  type PasswordEntry,
} from "../src/oauth/chunked-password-entry.ts";

function vault() {
  const values = new Map<string, string>();
  let rejectedAccount: string | null = null;
  let fragmentWritesBeforeFailure: number | null = null;
  const open = (account: string): PasswordEntry => ({
    async getPassword() {
      return values.get(account) ?? null;
    },
    async setPassword(password) {
      if (Buffer.byteLength(password, "utf16le") > 2_560)
        throw new Error("Windows credential blob limit exceeded.");
      if (account === rejectedAccount) throw new Error("Synthetic write failure.");
      if (account !== "subscription-oauth" && fragmentWritesBeforeFailure !== null) {
        if (fragmentWritesBeforeFailure === 0) throw new Error("Synthetic fragment failure.");
        fragmentWritesBeforeFailure--;
      }
      values.set(account, password);
    },
    async deleteCredential() {
      return values.delete(account);
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

test("treats a native null result as a signed-out credential store", async () => {
  const storage = vault();
  const store = createKeychainCredentialStore(() => storage.open("subscription-oauth"));
  expect(await store.read("openai")).toBeNull();
  const client = createSubscriptionOAuthClient({ protocol: providerProtocols.openai, store });
  expect((await client.status()).connected).toBe(false);
  expect(await storage.entry().getPassword()).toBeUndefined();
});

test("round-trips a long OpenAI credential across fresh vault entries within the Windows limit", async () => {
  const storage = vault();
  const credential = JSON.stringify({
    accessToken: "access".repeat(800),
    refreshToken: "refresh".repeat(300),
    idToken: "identity".repeat(500),
    accountId: "synthetic-account",
    expiresAt: 123_456,
  });
  await expect(storage.open("subscription-oauth").setPassword(credential)).rejects.toThrow("limit");
  await storage.entry().setPassword(credential);
  expect(await storage.entry().getPassword()).toBe(credential);
  expect(storage.values.size).toBeGreaterThan(2);
  for (const value of storage.values.values())
    expect(Buffer.byteLength(value, "utf16le")).toBeLessThanOrEqual(2_560);
  await storage.entry().deleteCredential();
  expect(storage.values.size).toBe(0);
  expect(await storage.entry().getPassword()).toBeUndefined();
  expect(await storage.entry().deleteCredential()).toBe(false);
});

test("preserves existing unchunked credentials and the exact 1,280 character boundary", async () => {
  const storage = vault();
  storage.values.set("subscription-oauth", '{"accessToken":"legacy"}');
  expect(await storage.entry().getPassword()).toBe('{"accessToken":"legacy"}');
  for (const length of [1_280, 1_281]) {
    const password = "x".repeat(length);
    await storage.entry().setPassword(password);
    expect(await storage.entry().getPassword()).toBe(password);
    expect(storage.values.size).toBe(length === 1_280 ? 1 : 3);
  }
});

test("cleans up retired fragments on refresh and when replacing a long credential with a short one", async () => {
  const storage = vault();
  await storage.entry().setPassword("old".repeat(3_000));
  const oldAccounts = Array.from(storage.values.keys()).filter(
    (key) => key !== "subscription-oauth",
  );
  await storage.entry().setPassword("new".repeat(1_000));
  expect(await storage.entry().getPassword()).toBe("new".repeat(1_000));
  for (const account of oldAccounts) expect(storage.values.has(account)).toBe(false);
  await storage.entry().setPassword("short");
  expect(Array.from(storage.values.entries())).toEqual([["subscription-oauth", "short"]]);
});

test.each(["fragment", "manifest"] as const)(
  "keeps the previous credential and removes staged fragments after a failed %s write",
  async (stage) => {
    const storage = vault();
    const password = "previous".repeat(600);
    await storage.entry().setPassword(password);
    const previous = Array.from(storage.values.entries());
    if (stage === "fragment") storage.failFragmentWrite();
    else storage.failRootWrite();
    await expect(storage.entry().setPassword("replacement".repeat(500))).rejects.toThrow(
      "Synthetic",
    );
    expect(await storage.entry().getPassword()).toBe(password);
    expect(Array.from(storage.values.entries())).toEqual(previous);
  },
);

test("rejects missing or corrupted fragments instead of returning partial credentials", async () => {
  for (const corruption of ["missing", "changed"] as const) {
    const storage = vault();
    await storage.entry().setPassword("credential".repeat(400));
    const account = Array.from(storage.values.keys()).find((key) => key !== "subscription-oauth")!;
    if (corruption === "missing") storage.values.delete(account);
    else storage.values.set(account, "corrupted");
    await expect(storage.entry().getPassword()).rejects.toThrow("Incomplete");
  }
});

test("rejects malformed manifests and excessive fragment counts", async () => {
  const storage = vault();
  storage.values.set("subscription-oauth", "context-agent:chunked-password:v1:{}");
  await expect(storage.entry().getPassword()).rejects.toThrow("Invalid credential manifest");
  storage.values.clear();
  await expect(storage.entry().setPassword("x".repeat(1_280 * 256 + 1))).rejects.toThrow(
    "fragment limit",
  );
  expect(storage.values.size).toBe(0);
});

test("preserves Unicode credentials across ASCII fragments", async () => {
  const storage = vault();
  const password = "x".repeat(1_279) + "😀유원범".repeat(500);
  await storage.entry().setPassword(password);
  expect(await storage.entry().getPassword()).toBe(password);
});

test("completes OpenAI login, refresh and logout with long vault credentials without a proxy attempt", async () => {
  const storage = vault();
  const store = createKeychainCredentialStore(() => storage.entry());
  let tokenRequests = 0;
  let proxyAttempts = 0;
  const client = createSubscriptionOAuthClient({
    protocol: { ...providerProtocols.openai, callbackPort: null },
    store,
    fetch: async () => {
      tokenRequests++;
      return Response.json({
        access_token: `access-${tokenRequests}-` + "x".repeat(4_000),
        refresh_token: `refresh-${tokenRequests}-` + "y".repeat(2_000),
        id_token: "z".repeat(3_000),
        expires_in: 3_600,
      });
    },
    tokenProxyFetch: async () => {
      proxyAttempts++;
      throw new Error("Proxy must not be used for successful direct requests.");
    },
  });
  const attempt = await client.startLogin({ timeoutMs: 5_000 });
  const completion = attempt.completed;
  void completion.catch(() => {});
  try {
    const authorization = new URL(attempt.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-code");
    expect((await fetch(callback)).status).toBe(200);
    expect((await completion).connected).toBe(true);
    expect((await client.refreshForValidation()).connected).toBe(true);
    expect((await store.read("openai"))?.accessToken).toContain("access-2-");
    expect(tokenRequests).toBe(2);
    expect(proxyAttempts).toBe(0);
    expect((await client.disconnect()).connected).toBe(false);
    expect(storage.values.size).toBe(0);
  } finally {
    attempt.cancel();
  }
});
