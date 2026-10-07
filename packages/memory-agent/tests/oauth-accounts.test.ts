import { Cause, Effect, FileSystem, MutableHashMap, Option, Path, Result, Schema } from "effect";
import { it } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vite-plus/test";
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
import { withTestPlatform } from "./support/platform.ts";

const scopedSqlite = Effect.fn("oauthAccounts.sqlite")((file: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(file)),
    (sqlite) =>
      Effect.sync(() => {
        if (sqlite.isOpen) sqlite.close();
      }),
  ),
);
const call = Effect.fn("oauthAccounts.sdkCall")(<A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) }),
);
const rejects = Effect.fn("oauthAccounts.rejects")(function* <A>(
  operation: () => Promise<A>,
  message: string,
) {
  const outcome = yield* Effect.result(call(operation));
  Result.match(outcome, {
    onFailure: (error) =>
      expect(() => {
        throw error.cause;
      }).toThrow(message),
    onSuccess: () => expect.fail("Expected the OAuth profile operation to reject"),
  });
});
const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
const fixture = Effect.fn("oauthAccounts.fixture")(function* () {
  const sqlite = yield* scopedSqlite(":memory:");
  sqlite.exec(oauthSchema);
  const legacySecrets = MutableHashMap.empty<OAuthProvider, StoredCredential>();
  const profileSecrets = MutableHashMap.empty<string, StoredCredential>();
  const legacy: CredentialStore = {
    read: (provider) =>
      Promise.resolve(Option.getOrUndefined(MutableHashMap.get(legacySecrets, provider)) ?? null),
    write: (provider, value) => {
      MutableHashMap.set(legacySecrets, provider, value);
      return Promise.resolve();
    },
    remove: (provider) => {
      MutableHashMap.remove(legacySecrets, provider);
      return Promise.resolve();
    },
  };
  const accounts = createProfileCredentialStore((id) => ({
    read: (provider) =>
      Promise.resolve(
        Option.getOrUndefined(MutableHashMap.get(profileSecrets, `${provider}:${id}`)) ?? null,
      ),
    write: (provider, value) => {
      MutableHashMap.set(profileSecrets, `${provider}:${id}`, value);
      return Promise.resolve();
    },
    remove: (provider) => {
      MutableHashMap.remove(profileSecrets, `${provider}:${id}`);
      return Promise.resolve();
    },
  }));
  return { sqlite, legacy, accounts, legacySecrets, profileSecrets };
});

describe("OAuth per-profile secret storage and non-destructive migration", () => {
  it.live("two profiles per provider have isolated secrets and secret-free metadata", () =>
    Effect.gen(function* () {
      const { sqlite, accounts, profileSecrets } = yield* fixture();
      try {
        for (const [index, provider] of providers.entries()) {
          for (const suffix of [1, 2]) {
            const id = `00000000-0000-4000-8000-${String(index * 2 + suffix).padStart(12, "0")}`;
            sqlite
              .prepare("INSERT INTO oauth_profiles VALUES (?, ?, ?, 0, 1)")
              .run(id, provider, `로컬 ${id}`);
            yield* call(() => accounts.write(provider, id, token(`${provider}-${id}`)));
          }
        }
        for (const [index, provider] of providers.entries()) {
          for (const suffix of [1, 2]) {
            const id = `00000000-0000-4000-8000-${String(index * 2 + suffix).padStart(12, "0")}`;
            expect(yield* call(() => accounts.read(provider, id))).toEqual(
              token(`${provider}-${id}`),
            );
          }
        }
        expect(MutableHashMap.size(profileSecrets)).toBe(4);
        expect(yield* serialize(listOAuthProfiles(sqlite))).not.toContain("access-");
        expect(yield* serialize(listOAuthProfiles(sqlite))).not.toContain("refresh-");
      } finally {
        sqlite.close();
      }
    }).pipe(withTestPlatform),
  );

  it.live.each(providers)(
    "copies %s legacy credential, verifies, retains original and survives repeat",
    (provider) =>
      Effect.gen(function* () {
        const { sqlite, legacy, accounts, legacySecrets } = yield* fixture();
        try {
          yield* call(() => legacy.write(provider, token(provider)));
          const imported = yield* call(() =>
            importLegacyOAuthProfile(sqlite, provider, accounts, legacy),
          );
          expect(imported).toMatchObject({ id: `legacy-${provider}`, provider, selected: true });
          expect(yield* call(() => accounts.read(provider, `legacy-${provider}`))).toEqual(
            token(provider),
          );
          expect(yield* call(() => legacy.read(provider))).toEqual(token(provider));
          expect(
            yield* call(() => importLegacyOAuthProfile(sqlite, provider, accounts, legacy)),
          ).toEqual(imported);
          expect(listOAuthProfiles(sqlite, provider)).toHaveLength(1);
          expect(MutableHashMap.size(legacySecrets)).toBe(1);
        } finally {
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live(
    "a failed copy or readback never publishes metadata or removes legacy; retry succeeds",
    () =>
      Effect.gen(function* () {
        const { sqlite, legacy, accounts } = yield* fixture();
        try {
          yield* call(() => legacy.write("openai", token("original")));
          const failed = createProfileCredentialStore(() => ({
            read: () => Promise.resolve(null),
            write: () => Promise.reject(new Error("disk unavailable")),
            remove: () => Promise.reject(new Error("must not delete")),
          }));
          yield* rejects(
            () => importLegacyOAuthProfile(sqlite, "openai", failed, legacy),
            "disk unavailable",
          );
          expect(listOAuthProfiles(sqlite)).toEqual([]);
          expect(yield* call(() => legacy.read("openai"))).toEqual(token("original"));
          const noReadback = createProfileCredentialStore(() => ({
            read: () => Promise.resolve(null),
            write: () => Promise.resolve(),
            remove: () => Promise.reject(new Error("must not delete")),
          }));
          yield* rejects(
            () => importLegacyOAuthProfile(sqlite, "openai", noReadback, legacy),
            "oauth_profile_copy_unverified",
          );
          expect(listOAuthProfiles(sqlite)).toEqual([]);
          expect(
            yield* call(() => importLegacyOAuthProfile(sqlite, "openai", accounts, legacy)),
          ).toMatchObject({
            selected: true,
          });
        } finally {
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live(
    "publishes verified accounts without replacing selection; scoped switch persists on reopen",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "oauth-profiles-" });
        const path = pathService.join(directory, "agent.db");
        const { sqlite: unused, accounts, legacy } = yield* fixture();
        unused.close();
        const sqlite = yield* scopedSqlite(path);
        try {
          sqlite.exec(oauthSchema);
          for (const provider of providers) {
            yield* call(() => legacy.write(provider, token(`original-${provider}`)));
            yield* call(() => importLegacyOAuthProfile(sqlite, provider, accounts, legacy));
            for (const suffix of [1, 2]) {
              const id = `00000000-0000-4000-8000-${String((provider === "openai" ? 0 : 2) + suffix).padStart(12, "0")}`;
              yield* call(() => accounts.write(provider, id, token(`${provider}-${suffix}`)));
              expect(
                yield* call(() =>
                  publishOAuthProfile(sqlite, provider, id, `계정 ${suffix}`, accounts),
                ),
              ).toMatchObject({ selected: false });
            }
          }
          expect(listOAuthProfiles(sqlite, "openai").find((p) => p.selected)?.id).toBe(
            "legacy-openai",
          );
          const chosen = "00000000-0000-4000-8000-000000000002";
          yield* call(() => selectOAuthProfile(sqlite, "openai", chosen, accounts));
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
          expect(yield* call(() => legacy.read("openai"))).toEqual(token("original-openai"));
          sqlite.close();
          const reopened = yield* scopedSqlite(path);
          try {
            expect(
              listOAuthProfiles(reopened, "openai")
                .filter((p) => p.selected)
                .map((p) => p.id),
            ).toEqual([chosen]);
            expect(yield* serialize(listOAuthProfiles(reopened))).not.toContain("access-");
          } finally {
            reopened.close();
          }
        } finally {
          if (sqlite.isOpen) sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live(
    "rejects missing credentials, invalid labels and cross-provider selection without altering active profile",
    () =>
      Effect.gen(function* () {
        const { sqlite, accounts, legacy } = yield* fixture();
        const id = "00000000-0000-4000-8000-000000000001";
        try {
          yield* call(() => legacy.write("openai", token("original")));
          yield* call(() => importLegacyOAuthProfile(sqlite, "openai", accounts, legacy));
          yield* rejects(
            () => publishOAuthProfile(sqlite, "openai", id, "unverified", accounts),
            "missing_credential",
          );
          yield* call(() => accounts.write("openai", id, token("new")));
          yield* rejects(
            () => publishOAuthProfile(sqlite, "openai", id, " ", accounts),
            "invalid_oauth_profile",
          );
          yield* call(() => publishOAuthProfile(sqlite, "openai", id, "새 계정", accounts));
          expect(renameOAuthProfile(sqlite, "openai", id, "  두 번째  ").label).toBe("두 번째");
          expect(() => renameOAuthProfile(sqlite, "anthropic", id, "가짜")).toThrow("not_found");
          expect(listOAuthProfiles(sqlite, "openai").find((p) => p.id === id)?.label).toBe(
            "두 번째",
          );
          yield* rejects(() => selectOAuthProfile(sqlite, "anthropic", id, accounts), "not_found");
          yield* call(() => accounts.remove("openai", id));
          yield* rejects(
            () => selectOAuthProfile(sqlite, "openai", id, accounts),
            "missing_credential",
          );
          expect(listOAuthProfiles(sqlite, "openai").find((p) => p.selected)?.id).toBe(
            "legacy-openai",
          );
        } finally {
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live(
    "removing selected profile chooses an intact fallback and does not touch the other provider",
    () =>
      Effect.gen(function* () {
        const { sqlite, legacy, accounts } = yield* fixture();
        try {
          for (const provider of providers) {
            yield* call(() => legacy.write(provider, token(`original-${provider}`)));
            yield* call(() => importLegacyOAuthProfile(sqlite, provider, accounts, legacy));
          }
          const first = "00000000-0000-4000-8000-000000000001";
          const second = "00000000-0000-4000-8000-000000000002";
          yield* call(() => accounts.write("openai", first, token("first")));
          yield* call(() => accounts.write("openai", second, token("second")));
          yield* call(() => publishOAuthProfile(sqlite, "openai", first, "first", accounts));
          yield* call(() => publishOAuthProfile(sqlite, "openai", second, "second", accounts));
          yield* call(() => selectOAuthProfile(sqlite, "openai", second, accounts));
          yield* rejects(
            () => removeOAuthProfile(sqlite, "anthropic", second, accounts, legacy),
            "not_found",
          );
          const remaining = yield* call(() =>
            removeOAuthProfile(sqlite, "openai", second, accounts, legacy),
          );
          expect(remaining.some((profile) => profile.id === second)).toBe(false);
          expect(remaining.filter((profile) => profile.selected)).toHaveLength(1);
          expect(yield* call(() => accounts.read("openai", first))).toEqual(token("first"));
          expect(yield* call(() => accounts.read("openai", second))).toBeNull();
          expect(yield* call(() => legacy.read("openai"))).toEqual(token("original-openai"));
          expect(listOAuthProfiles(sqlite, "anthropic").find((p) => p.selected)?.id).toBe(
            "legacy-anthropic",
          );
        } finally {
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live(
    "explicitly removing legacy account prevents silent re-import even if vault deletion fails",
    () =>
      Effect.gen(function* () {
        const { sqlite, legacy, accounts } = yield* fixture();
        try {
          yield* call(() => legacy.write("openai", token("original")));
          yield* call(() => importLegacyOAuthProfile(sqlite, "openai", accounts, legacy));
          const failed: CredentialStore = {
            read: (provider) => legacy.read(provider),
            write: (provider, value) => legacy.write(provider, value),
            remove: () => Promise.reject(new Error("vault unavailable")),
          };
          yield* rejects(
            () => removeOAuthProfile(sqlite, "openai", "legacy-openai", accounts, failed),
            "vault unavailable",
          );
          expect(
            yield* call(() => importLegacyOAuthProfile(sqlite, "openai", accounts, legacy)),
          ).toBeNull();
          expect(yield* call(() => legacy.read("openai"))).toEqual(token("original"));
          expect(listOAuthProfiles(sqlite, "openai")).toHaveLength(1);
          expect(
            yield* call(() =>
              removeOAuthProfile(sqlite, "openai", "legacy-openai", accounts, legacy),
            ),
          ).toEqual([]);
          expect(yield* call(() => legacy.read("openai"))).toBeNull();
          expect(yield* call(() => accounts.read("openai", "legacy-openai"))).toBeNull();
          expect(
            yield* call(() => importLegacyOAuthProfile(sqlite, "openai", accounts, legacy)),
          ).toBeNull();
        } finally {
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live(
    "a published profile with a missing copied slot is safely restored from intact legacy",
    () =>
      Effect.gen(function* () {
        const { sqlite, legacy, accounts } = yield* fixture();
        try {
          yield* call(() => legacy.write("openai", token("original")));
          yield* call(() => importLegacyOAuthProfile(sqlite, "openai", accounts, legacy));
          yield* call(() => accounts.remove("openai", "legacy-openai"));
          const restored = yield* call(() =>
            importLegacyOAuthProfile(sqlite, "openai", accounts, legacy),
          );
          expect(restored).toMatchObject({ id: "legacy-openai", selected: true });
          expect(yield* call(() => accounts.read("openai", "legacy-openai"))).toEqual(
            token("original"),
          );
          expect(yield* call(() => legacy.read("openai"))).toEqual(token("original"));
        } finally {
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live("an orphaned conflicting keychain slot is never overwritten", () =>
    Effect.gen(function* () {
      const { sqlite, legacy, accounts } = yield* fixture();
      try {
        yield* call(() => legacy.write("anthropic", token("legacy")));
        yield* call(() => accounts.write("anthropic", "legacy-anthropic", token("different")));
        yield* rejects(
          () => importLegacyOAuthProfile(sqlite, "anthropic", accounts, legacy),
          "oauth_profile_conflicting_credential",
        );
        expect(yield* call(() => accounts.read("anthropic", "legacy-anthropic"))).toEqual(
          token("different"),
        );
        expect(yield* call(() => legacy.read("anthropic"))).toEqual(token("legacy"));
        expect(listOAuthProfiles(sqlite)).toEqual([]);
      } finally {
        sqlite.close();
      }
    }).pipe(withTestPlatform),
  );
});
