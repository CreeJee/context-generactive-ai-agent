import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";
import { createAccountBoundSubscriptionClients } from "../src/oauth/account-bound.ts";
import {
  listOAuthProfiles,
  removeOAuthProfile,
  selectOAuthProfile,
  type ProfileCredentialStore,
} from "../src/oauth/accounts.ts";
import { acquireOAuthProfileRun } from "../src/oauth/run-leases.ts";
import {
  OAuthHarnessError,
  type CredentialStore,
  type OAuthConnectionStatus,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import type { SubscriptionOAuthClient } from "../src/oauth/validation-harness.ts";
import { providerProtocols, type OAuthProvider } from "../src/oauth/protocol.ts";
import { createSubscriptionProvider } from "../src/providers/subscription-provider.ts";
import {
  createSubscriptionRuntime,
  releaseSubscriptionRun,
} from "../src/providers/subscription-runtime.ts";

const oauthSchema = migrations
  .filter(
    (sql) =>
      sql.includes("CREATE TABLE oauth_profiles (") ||
      sql.includes("CREATE TABLE oauth_legacy_removed ("),
  )
  .join("\n");
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
const dbFixture = (provider: OAuthProvider = "openai") => {
  const db = new DatabaseSync(":memory:");
  db.exec(oauthSchema);
  for (const [index, id] of ids.entries())
    db.prepare(
      "INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, provider, `account ${index}`, index === 0 ? 1 : 0, index);
  return db;
};
const select = (db: DatabaseSync, id: string, provider: OAuthProvider = "openai") => {
  db.prepare("UPDATE oauth_profiles SET selected = 0 WHERE provider = ?").run(provider);
  db.prepare("UPDATE oauth_profiles SET selected = 1 WHERE id = ? AND provider = ?").run(
    id,
    provider,
  );
};

describe("account-bound subscription provider", () => {
  test.each(["openai", "anthropic"] as const)(
    "%s can log in again after removing the last legacy account",
    async (provider) => {
      const db = new DatabaseSync(":memory:");
      db.exec(oauthSchema);
      const legacyId = `legacy-${provider}`;
      db.prepare(
        "INSERT INTO oauth_profiles(id, provider, label, selected, created_at) VALUES (?, ?, ?, 1, 0)",
      ).run(legacyId, provider, "old account");
      const credential: StoredCredential = {
        accessToken: "fake",
        refreshToken: "fake",
        expiresAt: 123,
      };
      const vault = new Map<string, StoredCredential>([[legacyId, credential]]);
      const accounts: ProfileCredentialStore = {
        read: async (_provider, id) => vault.get(id) ?? null,
        write: async (_provider, id, value) => {
          vault.set(id, value);
        },
        remove: async (_provider, id) => {
          vault.delete(id);
        },
      };
      let legacyRemoved = false;
      const legacy: CredentialStore = {
        read: async () => (legacyRemoved ? null : credential),
        write: async () => {},
        remove: async () => {
          legacyRemoved = true;
        },
      };
      const created: string[] = [];
      let finish!: () => void;
      try {
        const bound = createAccountBoundSubscriptionClients(
          db,
          provider,
          (id) => ({
            status: async () => ({ provider, connected: vault.has(id!), expiresAt: null }),
            modelCatalog: async () => [],
            async *stream() {},
            refreshForValidation: async () => ({ provider, connected: true, expiresAt: null }),
            disconnect: async () => ({ provider, connected: false, expiresAt: null }),
            startLogin: async () => {
              expect(id).not.toBeNull();
              created.push(id!);
              const completed = new Promise<OAuthConnectionStatus>((resolve) => {
                finish = () => {
                  vault.set(id!, credential);
                  resolve({ provider, connected: true, expiresAt: null });
                };
              });
              return {
                provider,
                authorizationUrl: "https://example.com/login",
                completed,
                cancel: () => {},
              };
            },
          }),
          accounts,
          legacy,
        );
        const configured = createSubscriptionProvider({
          protocol: providerProtocols[provider],
          config: { read: Effect.succeed({}), update: (patch) => Effect.succeed(patch) },
          client: bound.client,
          catalogKey: bound.catalogKey,
        });
        for (let round = 0; round < 2; round++) {
          expect((await Effect.runPromise(configured.auth.disconnect)).status).toBe("signed-out");
          expect(listOAuthProfiles(db, provider)).toEqual([]);
          expect(() => bound.forRun()).toThrow("not_connected");
          expect((await Effect.runPromise(configured.auth.connect)).status).toBe("pending");
          expect(listOAuthProfiles(db, provider)).toEqual([]);
          finish();
          await expect
            .poll(async () => (await Effect.runPromise(configured.auth.status)).status)
            .toBe("signed-in");
          expect(listOAuthProfiles(db, provider)).toMatchObject([
            { id: created[round], provider, selected: true },
          ]);
          bound.forRun().releaseRun();
        }
        expect(legacyRemoved).toBe(true);
        expect(new Set(created).size).toBe(2);
        expect(db.prepare("SELECT provider FROM oauth_legacy_removed").get()).toEqual({ provider });
      } finally {
        db.close();
      }
    },
  );

  test.each(["cancel", "reject"] as const)(
    "%s leaves no newly connected account",
    async (intent) => {
      const db = new DatabaseSync(":memory:");
      db.exec(oauthSchema);
      db.prepare(
        "INSERT INTO oauth_legacy_removed(provider, removed_at) VALUES ('openai', 0)",
      ).run();
      const removed: string[] = [];
      const accounts: ProfileCredentialStore = {
        read: async () => null,
        write: async () => {},
        remove: async (_provider, id) => {
          removed.push(id);
        },
      };
      let finish!: () => void;
      try {
        const bound = createAccountBoundSubscriptionClients(
          db,
          "openai",
          () => ({
            status: async () => ({ provider: "openai", connected: false, expiresAt: null }),
            modelCatalog: async () => [],
            async *stream() {},
            refreshForValidation: async () => ({
              provider: "openai",
              connected: false,
              expiresAt: null,
            }),
            disconnect: async () => ({ provider: "openai", connected: false, expiresAt: null }),
            startLogin: async () => ({
              provider: "openai",
              authorizationUrl: "https://example.com/login",
              completed: new Promise<OAuthConnectionStatus>((resolve, reject) => {
                finish = () =>
                  intent === "reject"
                    ? reject(new OAuthHarnessError("provider_rejected"))
                    : resolve({ provider: "openai", connected: true, expiresAt: null });
              }),
              cancel: () => {},
            }),
          }),
          accounts,
        );
        const attempt = await bound.client.startLogin();
        if (intent === "cancel") attempt.cancel();
        finish();
        await expect(attempt.completed).rejects.toThrow(
          intent === "cancel" ? "cancelled" : "provider_rejected",
        );
        expect(removed).toHaveLength(1);
        expect(listOAuthProfiles(db, "openai")).toEqual([]);
        expect((await bound.client.status()).connected).toBe(false);
        expect(() => bound.forRun()).toThrow("not_connected");
      } finally {
        db.close();
      }
    },
  );

  test.each(["openai", "anthropic"] as const)(
    "%s keeps A's stream/refresh bound after switching to B",
    async (provider) => {
      const db = dbFixture(provider);
      const calls: string[] = [];
      try {
        const bound = createAccountBoundSubscriptionClients(db, provider, (id) => ({
          status: async () => ({ provider, connected: true, expiresAt: null }),
          modelCatalog: async () => {
            calls.push(`catalog:${id}`);
            return [];
          },
          async *stream() {
            calls.push(`stream:${id}`);
            yield* [];
          },
          refreshForValidation: async () => {
            calls.push(`refresh:${id}`);
            return { provider, connected: true, expiresAt: null };
          },
          disconnect: async () => ({ provider, connected: false, expiresAt: null }),
          startLogin: async () => {
            throw new Error("unexpected login");
          },
        }));
        const a = bound.forRun();
        select(db, ids[1], provider);
        const b = bound.forRun();
        await bound.client.modelCatalog();
        for await (const _ of a.stream("{}")) {
          /* consume */
        }
        for await (const _ of b.stream("{}")) {
          /* consume */
        }
        await a.refreshForValidation();
        await b.refreshForValidation();
        expect(calls).toEqual([
          `catalog:${ids[1]}`,
          `stream:${ids[0]}`,
          `stream:${ids[1]}`,
          `refresh:${ids[0]}`,
          `refresh:${ids[1]}`,
        ]);
        a.releaseRun();
        b.releaseRun();
      } finally {
        db.close();
      }
    },
  );

  test("catalog/status and a pinned run keep their original account on A/B switches", async () => {
    const db = dbFixture();
    const calls: string[] = [];
    const created: string[] = [];
    try {
      const bound = createAccountBoundSubscriptionClients(db, "openai", (id) => {
        created.push(id ?? "legacy");
        return {
          status: async () => {
            calls.push(`status:${id}`);
            return { provider: "openai", connected: true, expiresAt: null };
          },
          modelCatalog: async () => {
            calls.push(`catalog:${id}`);
            return [{ models: [{ slug: `model-${id}` }] }];
          },
          async *stream() {
            calls.push(`stream:${id}`);
            yield* [];
          },
          refreshForValidation: async () => {
            calls.push(`refresh:${id}`);
            return { provider: "openai", connected: true, expiresAt: null };
          },
          disconnect: async () => ({ provider: "openai", connected: false, expiresAt: null }),
          startLogin: async () => {
            throw new Error("unexpected login");
          },
        } satisfies SubscriptionOAuthClient;
      });
      const runtime = createSubscriptionRuntime("openai", bound.forRun);
      const selection = { provider: "openai", model: "gpt-test", reasoningEffort: "low" } as const;
      const firstAdapter = runtime.adapter(selection);
      const aRun = bound.forRun();
      expect(bound.catalogKey()).toBe(ids[0]);
      select(db, ids[1]);
      const secondAdapter = runtime.adapter(selection);
      expect(firstAdapter).not.toBe(secondAdapter);
      const bRun = bound.forRun();
      await bound.client.status();
      await bound.client.modelCatalog();
      for await (const _ of aRun.stream("{}")) {
        /* consume */
      }
      for await (const _ of bRun.stream("{}")) {
        /* consume */
      }
      await aRun.refreshForValidation();
      await bRun.refreshForValidation();
      expect(created).toEqual([ids[0], ids[1]]);
      expect(calls).toEqual([
        `status:${ids[1]}`,
        `catalog:${ids[1]}`,
        `stream:${ids[0]}`,
        `stream:${ids[1]}`,
        `refresh:${ids[0]}`,
        `refresh:${ids[1]}`,
      ]);
      releaseSubscriptionRun(firstAdapter);
      releaseSubscriptionRun(secondAdapter);
      aRun.releaseRun();
      bRun.releaseRun();
    } finally {
      db.close();
    }
  });

  test("OpenAI model cache and context window cannot leak across selected profiles", async () => {
    const db = dbFixture();
    const requests: string[] = [];
    try {
      const bound = createAccountBoundSubscriptionClients(db, "openai", (id) => ({
        status: async () => ({ provider: "openai", connected: true, expiresAt: null }),
        modelCatalog: async () => {
          requests.push(id!);
          return [
            {
              models: [
                {
                  slug: id === ids[0] ? "model-a" : "model-b",
                  context_window: id === ids[0] ? 100_000 : 200_000,
                },
              ],
            },
          ];
        },
        async *stream() {},
        refreshForValidation: async () => ({
          provider: "openai",
          connected: true,
          expiresAt: null,
        }),
        disconnect: async () => ({ provider: "openai", connected: false, expiresAt: null }),
        startLogin: async () => {
          throw new Error("unexpected login");
        },
      }));
      const provider = createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config: { read: Effect.succeed({}), update: (patch) => Effect.succeed(patch) },
        client: bound.client,
        catalogKey: bound.catalogKey,
      });
      expect((await Effect.runPromise(provider.models.list)).map((m) => m.id)).toEqual(["model-a"]);
      expect(provider.contextWindow("model-a")).toBe(100_000);
      select(db, ids[1]);
      expect(provider.contextWindow("model-a")).toBeNull();
      expect((await Effect.runPromise(provider.models.list)).map((m) => m.id)).toEqual(["model-b"]);
      expect(provider.contextWindow("model-b")).toBe(200_000);
      expect(requests).toEqual([ids[0], ids[1]]);
    } finally {
      db.close();
    }
  });

  test("an active run blocks only its own profile deletion until released, even after A/B switch", async () => {
    const db = dbFixture();
    const credential: StoredCredential = {
      accessToken: "fake",
      refreshToken: "fake",
      expiresAt: 123,
    };
    const vault = new Map<string, StoredCredential>(ids.map((id) => [id, credential]));
    const accounts: ProfileCredentialStore = {
      read: async (_provider, id) => vault.get(id) ?? null,
      write: async (_provider, id, value) => {
        vault.set(id, value);
      },
      remove: async (_provider, id) => {
        vault.delete(id);
      },
    };
    const legacy: CredentialStore = {
      read: async () => null,
      write: async () => {},
      remove: async () => {},
    };
    try {
      const bound = createAccountBoundSubscriptionClients(db, "openai", () => ({
        status: async () => ({ provider: "openai", connected: true, expiresAt: null }),
        modelCatalog: async () => [],
        async *stream() {},
        refreshForValidation: async () => ({
          provider: "openai",
          connected: true,
          expiresAt: null,
        }),
        disconnect: async () => ({ provider: "openai", connected: false, expiresAt: null }),
        startLogin: async () => {
          throw new Error("unexpected login");
        },
      }));
      const pinnedA = bound.forRun();
      select(db, ids[1]);
      const pinnedB = bound.forRun();
      await expect(removeOAuthProfile(db, "openai", ids[0], accounts, legacy)).rejects.toThrow(
        "oauth_profile_in_use",
      );
      expect(vault.has(ids[0])).toBe(true);
      pinnedA.releaseRun();
      pinnedA.releaseRun(); // release is idempotent
      await removeOAuthProfile(db, "openai", ids[0], accounts, legacy);
      expect(vault.has(ids[0])).toBe(false);
      expect(vault.has(ids[1])).toBe(true);
      expect(db.prepare("SELECT id FROM oauth_profiles WHERE selected = 1").get()).toEqual({
        id: ids[1],
      });
      await expect(removeOAuthProfile(db, "openai", ids[1], accounts, legacy)).rejects.toThrow(
        "oauth_profile_in_use",
      );
      pinnedB.releaseRun();
    } finally {
      db.close();
    }
  });

  test("a pending vault deletion rejects a newly started run before any credential is removed", async () => {
    const db = dbFixture();
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continueRead!: () => void;
    const held = new Promise<void>((resolve) => {
      continueRead = resolve;
    });
    const credential: StoredCredential = {
      accessToken: "fake",
      refreshToken: "fake",
      expiresAt: 123,
    };
    const accounts: ProfileCredentialStore = {
      read: async () => {
        entered();
        await held;
        return credential;
      },
      write: async () => {},
      remove: async () => {},
    };
    const legacy: CredentialStore = {
      read: async () => null,
      write: async () => {},
      remove: async () => {},
    };
    try {
      const bound = createAccountBoundSubscriptionClients(db, "openai", () => ({
        status: async () => ({ provider: "openai", connected: true, expiresAt: null }),
        modelCatalog: async () => [],
        async *stream() {},
        refreshForValidation: async () => ({
          provider: "openai",
          connected: true,
          expiresAt: null,
        }),
        disconnect: async () => ({ provider: "openai", connected: false, expiresAt: null }),
        startLogin: async () => {
          throw new Error("unexpected login");
        },
      }));
      const removal = removeOAuthProfile(db, "openai", ids[0], accounts, legacy);
      await reading;
      expect(() => bound.forRun()).toThrow("oauth_profile_removing");
      await expect(selectOAuthProfile(db, "openai", ids[0], accounts)).rejects.toThrow(
        "oauth_profile_removing",
      );
      continueRead();
      await removal;
      const next = bound.forRun(); // fallback selected B can run
      next.releaseRun();
    } finally {
      db.close();
    }
  });

  test("leases are provider-scoped on the same database", () => {
    const db = dbFixture();
    try {
      const release = acquireOAuthProfileRun(db, "openai", ids[0]);
      const releaseOther = acquireOAuthProfileRun(db, "anthropic", ids[0]);
      releaseOther();
      release();
    } finally {
      db.close();
    }
  });
});
