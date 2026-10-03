import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";
import {
  createProfileCredentialStore,
  importLegacyOAuthProfile,
  listOAuthProfiles,
  publishOAuthProfile,
  removeOAuthProfile,
  renameOAuthProfile,
  selectOAuthProfile,
} from "../src/oauth/accounts.ts";
import type { OAuthProvider } from "../src/oauth/protocol.ts";
import type { CredentialStore, StoredCredential } from "../src/oauth/validation-harness.ts";

const oauthSchema = migrations
  .filter(
    (sql) =>
      sql.includes("CREATE TABLE oauth_profiles (") ||
      sql.includes("CREATE TABLE oauth_legacy_removed ("),
  )
  .join("\n");
const providers: OAuthProvider[] = ["openai", "anthropic"];
const token = (value: string): StoredCredential => ({
  accessToken: `access-${value}`,
  refreshToken: `refresh-${value}`,
  expiresAt: 123,
});
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(oauthSchema);
  const legacySecrets = new Map<OAuthProvider, StoredCredential>();
  const profileSecrets = new Map<string, StoredCredential>();
  const legacy: CredentialStore = {
    read: async (provider) => legacySecrets.get(provider) ?? null,
    write: async (provider, value) => {
      legacySecrets.set(provider, value);
    },
    remove: async (provider) => {
      legacySecrets.delete(provider);
    },
  };
  const accounts = createProfileCredentialStore((id) => ({
    read: async (provider) => profileSecrets.get(`${provider}:${id}`) ?? null,
    write: async (provider, value) => {
      profileSecrets.set(`${provider}:${id}`, value);
    },
    remove: async (provider) => {
      profileSecrets.delete(`${provider}:${id}`);
    },
  }));
  return { sqlite, legacy, accounts, legacySecrets, profileSecrets };
}

describe("OAuth per-profile secret storage and non-destructive migration", () => {
  test("two profiles per provider have isolated secrets and secret-free metadata", async () => {
    const { sqlite, accounts, profileSecrets } = fixture();
    try {
      for (const [index, provider] of providers.entries()) {
        for (const suffix of [1, 2]) {
          const id = `00000000-0000-4000-8000-${String(index * 2 + suffix).padStart(12, "0")}`;
          sqlite
            .prepare("INSERT INTO oauth_profiles VALUES (?, ?, ?, 0, 1)")
            .run(id, provider, `로컬 ${id}`);
          await accounts.write(provider, id, token(`${provider}-${id}`));
        }
      }
      for (const [index, provider] of providers.entries()) {
        for (const suffix of [1, 2]) {
          const id = `00000000-0000-4000-8000-${String(index * 2 + suffix).padStart(12, "0")}`;
          expect(await accounts.read(provider, id)).toEqual(token(`${provider}-${id}`));
        }
      }
      expect(profileSecrets.size).toBe(4);
      expect(JSON.stringify(listOAuthProfiles(sqlite))).not.toContain("access-");
      expect(JSON.stringify(listOAuthProfiles(sqlite))).not.toContain("refresh-");
    } finally {
      sqlite.close();
    }
  });

  test.each(providers)(
    "copies %s legacy credential, verifies, retains original and survives repeat",
    async (provider) => {
      const { sqlite, legacy, accounts, legacySecrets } = fixture();
      try {
        await legacy.write(provider, token(provider));
        const imported = await importLegacyOAuthProfile(sqlite, provider, accounts, legacy);
        expect(imported).toMatchObject({ id: `legacy-${provider}`, provider, selected: true });
        expect(await accounts.read(provider, `legacy-${provider}`)).toEqual(token(provider));
        expect(await legacy.read(provider)).toEqual(token(provider));
        expect(await importLegacyOAuthProfile(sqlite, provider, accounts, legacy)).toEqual(
          imported,
        );
        expect(listOAuthProfiles(sqlite, provider)).toHaveLength(1);
        expect(legacySecrets.size).toBe(1);
      } finally {
        sqlite.close();
      }
    },
  );

  test("a failed copy or readback never publishes metadata or removes legacy; retry succeeds", async () => {
    const { sqlite, legacy, accounts } = fixture();
    try {
      await legacy.write("openai", token("original"));
      const failed = createProfileCredentialStore(() => ({
        read: async () => null,
        write: async () => {
          throw new Error("disk unavailable");
        },
        remove: async () => {
          throw new Error("must not delete");
        },
      }));
      await expect(importLegacyOAuthProfile(sqlite, "openai", failed, legacy)).rejects.toThrow(
        "disk unavailable",
      );
      expect(listOAuthProfiles(sqlite)).toEqual([]);
      expect(await legacy.read("openai")).toEqual(token("original"));
      const noReadback = createProfileCredentialStore(() => ({
        read: async () => null,
        write: async () => undefined,
        remove: async () => {
          throw new Error("must not delete");
        },
      }));
      await expect(importLegacyOAuthProfile(sqlite, "openai", noReadback, legacy)).rejects.toThrow(
        "oauth_profile_copy_unverified",
      );
      expect(listOAuthProfiles(sqlite)).toEqual([]);
      expect(await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy)).toMatchObject({
        selected: true,
      });
    } finally {
      sqlite.close();
    }
  });

  test("publishes verified accounts without replacing selection; scoped switch persists on reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oauth-profiles-"));
    const path = join(directory, "agent.db");
    const { sqlite: unused, accounts, legacy } = fixture();
    unused.close();
    const sqlite = new DatabaseSync(path);
    try {
      sqlite.exec(oauthSchema);
      for (const provider of providers) {
        await legacy.write(provider, token(`original-${provider}`));
        await importLegacyOAuthProfile(sqlite, provider, accounts, legacy);
        for (const suffix of [1, 2]) {
          const id = `00000000-0000-4000-8000-${String((provider === "openai" ? 0 : 2) + suffix).padStart(12, "0")}`;
          await accounts.write(provider, id, token(`${provider}-${suffix}`));
          expect(
            await publishOAuthProfile(sqlite, provider, id, `계정 ${suffix}`, accounts),
          ).toMatchObject({ selected: false });
        }
      }
      expect(listOAuthProfiles(sqlite, "openai").find((p) => p.selected)?.id).toBe("legacy-openai");
      const chosen = "00000000-0000-4000-8000-000000000002";
      await selectOAuthProfile(sqlite, "openai", chosen, accounts);
      expect(
        listOAuthProfiles(sqlite, "openai")
          .filter((p) => p.selected)
          .map((p) => p.id),
      ).toEqual([chosen]);
      expect(
        listOAuthProfiles(sqlite, "anthropic")
          .filter((p) => p.selected)
          .map((p) => p.id),
      ).toEqual(["legacy-anthropic"]);
      expect(await legacy.read("openai")).toEqual(token("original-openai"));
      sqlite.close();
      const reopened = new DatabaseSync(path);
      try {
        expect(
          listOAuthProfiles(reopened, "openai")
            .filter((p) => p.selected)
            .map((p) => p.id),
        ).toEqual([chosen]);
        expect(JSON.stringify(listOAuthProfiles(reopened))).not.toContain("access-");
      } finally {
        reopened.close();
      }
    } finally {
      if (sqlite.isOpen) sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects missing credentials, invalid labels and cross-provider selection without altering active profile", async () => {
    const { sqlite, accounts, legacy } = fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    try {
      await legacy.write("openai", token("original"));
      await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy);
      await expect(
        publishOAuthProfile(sqlite, "openai", id, "unverified", accounts),
      ).rejects.toThrow("missing_credential");
      await accounts.write("openai", id, token("new"));
      await expect(publishOAuthProfile(sqlite, "openai", id, " ", accounts)).rejects.toThrow(
        "invalid_oauth_profile",
      );
      await publishOAuthProfile(sqlite, "openai", id, "새 계정", accounts);
      expect(renameOAuthProfile(sqlite, "openai", id, "  두 번째  ").label).toBe("두 번째");
      expect(() => renameOAuthProfile(sqlite, "anthropic", id, "가짜")).toThrow("not_found");
      expect(listOAuthProfiles(sqlite, "openai").find((p) => p.id === id)?.label).toBe("두 번째");
      await expect(selectOAuthProfile(sqlite, "anthropic", id, accounts)).rejects.toThrow(
        "not_found",
      );
      await accounts.remove("openai", id);
      await expect(selectOAuthProfile(sqlite, "openai", id, accounts)).rejects.toThrow(
        "missing_credential",
      );
      expect(listOAuthProfiles(sqlite, "openai").find((p) => p.selected)?.id).toBe("legacy-openai");
    } finally {
      sqlite.close();
    }
  });

  test("removing selected profile chooses an intact fallback and does not touch the other provider", async () => {
    const { sqlite, legacy, accounts } = fixture();
    try {
      for (const provider of providers) {
        await legacy.write(provider, token(`original-${provider}`));
        await importLegacyOAuthProfile(sqlite, provider, accounts, legacy);
      }
      const first = "00000000-0000-4000-8000-000000000001";
      const second = "00000000-0000-4000-8000-000000000002";
      await accounts.write("openai", first, token("first"));
      await accounts.write("openai", second, token("second"));
      await publishOAuthProfile(sqlite, "openai", first, "first", accounts);
      await publishOAuthProfile(sqlite, "openai", second, "second", accounts);
      await selectOAuthProfile(sqlite, "openai", second, accounts);
      await expect(
        removeOAuthProfile(sqlite, "anthropic", second, accounts, legacy),
      ).rejects.toThrow("not_found");
      const remaining = await removeOAuthProfile(sqlite, "openai", second, accounts, legacy);
      expect(remaining.some((profile) => profile.id === second)).toBe(false);
      expect(remaining.filter((profile) => profile.selected)).toHaveLength(1);
      expect(await accounts.read("openai", first)).toEqual(token("first"));
      expect(await accounts.read("openai", second)).toBeNull();
      expect(await legacy.read("openai")).toEqual(token("original-openai"));
      expect(listOAuthProfiles(sqlite, "anthropic").find((p) => p.selected)?.id).toBe(
        "legacy-anthropic",
      );
    } finally {
      sqlite.close();
    }
  });

  test("explicitly removing legacy account prevents silent re-import even if vault deletion fails", async () => {
    const { sqlite, legacy, accounts } = fixture();
    try {
      await legacy.write("openai", token("original"));
      await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy);
      const failed: CredentialStore = {
        read: (provider) => legacy.read(provider),
        write: (provider, value) => legacy.write(provider, value),
        remove: async () => {
          throw new Error("vault unavailable");
        },
      };
      await expect(
        removeOAuthProfile(sqlite, "openai", "legacy-openai", accounts, failed),
      ).rejects.toThrow("vault unavailable");
      expect(await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy)).toBeNull();
      expect(await legacy.read("openai")).toEqual(token("original"));
      expect(listOAuthProfiles(sqlite, "openai")).toHaveLength(1);
      expect(await removeOAuthProfile(sqlite, "openai", "legacy-openai", accounts, legacy)).toEqual(
        [],
      );
      expect(await legacy.read("openai")).toBeNull();
      expect(await accounts.read("openai", "legacy-openai")).toBeNull();
      expect(await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  test("a published profile with a missing copied slot is safely restored from intact legacy", async () => {
    const { sqlite, legacy, accounts } = fixture();
    try {
      await legacy.write("openai", token("original"));
      await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy);
      await accounts.remove("openai", "legacy-openai");
      const restored = await importLegacyOAuthProfile(sqlite, "openai", accounts, legacy);
      expect(restored).toMatchObject({ id: "legacy-openai", selected: true });
      expect(await accounts.read("openai", "legacy-openai")).toEqual(token("original"));
      expect(await legacy.read("openai")).toEqual(token("original"));
    } finally {
      sqlite.close();
    }
  });

  test("an orphaned conflicting keychain slot is never overwritten", async () => {
    const { sqlite, legacy, accounts } = fixture();
    try {
      await legacy.write("anthropic", token("legacy"));
      await accounts.write("anthropic", "legacy-anthropic", token("different"));
      await expect(importLegacyOAuthProfile(sqlite, "anthropic", accounts, legacy)).rejects.toThrow(
        "oauth_profile_conflicting_credential",
      );
      expect(await accounts.read("anthropic", "legacy-anthropic")).toEqual(token("different"));
      expect(await legacy.read("anthropic")).toEqual(token("legacy"));
      expect(listOAuthProfiles(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
