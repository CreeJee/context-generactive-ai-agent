import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, vi } from "vite-plus/test";
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
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(oauthSchema);
  const slots = new Map<string, StoredCredential>();
  const accounts = createProfileCredentialStore((id) => ({
    read: async (provider) => slots.get(`${provider}:${id}`) ?? null,
    write: async (provider, value) => {
      slots.set(`${provider}:${id}`, value);
    },
    remove: async (provider) => {
      slots.delete(`${provider}:${id}`);
    },
  }));
  const legacy = new Map<OAuthProvider, StoredCredential>();
  const legacyStore: CredentialStore = {
    read: async (provider) => legacy.get(provider) ?? null,
    write: async (provider, value) => {
      legacy.set(provider, value);
    },
    remove: async (provider) => {
      legacy.delete(provider);
    },
  };
  const attempts = new Map<OAuthProvider, { id: string; succeed(): void; fail(): void }>();
  const start = async (provider: OAuthProvider, id: string): Promise<LoginAttempt> => {
    let succeed!: () => void;
    let fail!: () => void;
    const completed = new Promise<{
      provider: OAuthProvider;
      connected: boolean;
      expiresAt: number;
    }>((resolve, reject) => {
      succeed = () => resolve({ provider, connected: true, expiresAt: Date.now() + 60_000 });
      fail = () => reject(new Error("cancelled"));
    });
    attempts.set(provider, { id, succeed, fail });
    return {
      provider,
      authorizationUrl: `https://login.example/${provider}`,
      completed,
      cancel: fail,
    };
  };
  return {
    db,
    accounts,
    slots,
    legacy,
    legacyStore,
    attempts,
    manager: createOAuthAccountLoginManager(db, accounts, start),
  };
}

describe("multi-account OAuth login manager", () => {
  test.each(["openai", "anthropic"] as const)(
    "%s production callback admits one exchange and publishes one selected profile",
    async (provider) => {
      const { db, accounts, slots } = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const exchanging = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let writes = 0;
      const tokenFetch = vi.fn(async () => {
        entered();
        await gate;
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        });
      });
      let login!: LoginAttempt;
      const manager = createOAuthAccountLoginManager(db, accounts, async (p, id) => {
        login = await createSubscriptionOAuthClient({
          protocol: {
            ...providerProtocols[p],
            callbackPort: null,
            callbackRedirectHost: "127.0.0.1",
          },
          fetch: tokenFetch,
          store: {
            read: () => accounts.read(p, id),
            write: async (_, value) => {
              writes += 1;
              await accounts.write(p, id, value);
            },
            remove: () => accounts.remove(p, id),
          },
        }).startLogin();
        return login;
      });
      let first: Promise<Response> | undefined;
      try {
        const pending = await manager.start(provider, "concurrent profile");
        const authorize = new URL(pending.login.authorizationUrl!);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "first-code");
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        first = fetch(callback);
        await exchanging;
        for (const [code, state] of [
          ["first-code", authorize.searchParams.get("state")!],
          ["second-code", authorize.searchParams.get("state")!],
          ["second-code", "wrong-state"],
        ]) {
          const duplicate = new URL(callback);
          duplicate.searchParams.set("code", code!);
          duplicate.searchParams.set("state", state!);
          const rejected = await fetch(duplicate);
          expect(rejected.status).toBe(410);
          await rejected.text();
        }
        expect(tokenFetch).toHaveBeenCalledTimes(1);
        expect(writes).toBe(0);
        expect(manager.profiles(provider).profiles).toEqual([]);
        release();
        const response = await first;
        expect(response.status).toBe(200);
        await response.text();
        await login.completed;
        await vi.waitFor(() => expect(manager.profiles(provider).login.status).toBe("completed"));
        expect(writes).toBe(1);
        expect(slots.size).toBe(1);
        expect(manager.profiles(provider).profiles).toEqual([
          expect.objectContaining({ label: "concurrent profile", selected: true }),
        ]);
        expect(tokenFetch).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await first?.then((response) => response.text()).catch(() => {});
        await manager.cancel(provider);
        db.close();
      }
    },
  );
  test.each(["openai", "anthropic"] as const)(
    "%s adds two accounts without changing the legacy active slot",
    async (provider) => {
      const { db, accounts, slots, legacy, legacyStore, attempts, manager } = fixture();
      try {
        await legacyStore.write(provider, credential("original"));
        await importLegacyOAuthProfile(db, provider, accounts, legacyStore);
        for (const suffix of [1, 2]) {
          const pending = await manager.start(provider, `계정 ${suffix}`);
          expect(pending.login).toMatchObject({ status: "pending" });
          const attempt = attempts.get(provider)!;
          await accounts.write(provider, attempt.id, credential(`${provider}-${suffix}`));
          attempt.succeed();
          await vi.waitFor(() => expect(manager.profiles(provider).login.status).toBe("completed"));
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
        expect(legacy.get(provider)).toEqual(credential("original"));
        expect(slots.size).toBe(3);
      } finally {
        db.close();
      }
    },
  );

  test("cancel discards only the pending slot and retains other accounts", async () => {
    const { db, accounts, legacyStore, attempts, manager } = fixture();
    try {
      await legacyStore.write("openai", credential("original"));
      await importLegacyOAuthProfile(db, "openai", accounts, legacyStore);
      await manager.start("openai", "new account");
      const attempt = attempts.get("openai")!;
      await accounts.write("openai", attempt.id, credential("new"));
      await expect(manager.start("openai", "overlap")).rejects.toThrow("oauth_login_in_progress");
      await manager.cancel("openai");
      expect(await accounts.read("openai", attempt.id)).toBeNull();
      expect(manager.profiles("openai").profiles.map((p) => p.id)).toEqual(["legacy-openai"]);
      expect(await legacyStore.read("openai")).toEqual(credential("original"));
    } finally {
      db.close();
    }
  });
});
