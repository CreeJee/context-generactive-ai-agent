import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  MutableHashMap,
  Option,
  Path,
  Schema,
} from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import {
  createProfileCredentialStore,
  OAuthProfiles,
  type OAuthProfileRejected,
  type OAuthProfileStoreFailed,
} from "../src/oauth/accounts.ts";
import type { OAuthProvider } from "../src/oauth/protocol.ts";
import type { CredentialStore, StoredCredential } from "../src/oauth/validation-harness.ts";
import { withTestPlatform } from "./support/platform.ts";

const call = Effect.fn("oauthAccounts.sdkCall")(<A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) }),
);
/** The rejection code, or the keychain's own message when the vault failed. */
const failureText = (error: OAuthProfileRejected | OAuthProfileStoreFailed) => {
  switch (error._tag) {
    case "OAuthProfileRejected":
      return error.reason;
    case "OAuthProfileStoreFailed":
      return String(error.cause);
  }
};
const rejects = Effect.fn("oauthAccounts.rejects")(function* <A>(
  operation: Effect.Effect<A, OAuthProfileRejected | OAuthProfileStoreFailed>,
  message: string,
) {
  expect(failureText(yield* Effect.flip(operation))).toContain(message);
});
const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const providers: OAuthProvider[] = ["openai", "anthropic"];
const token = (value: string): StoredCredential => ({
  accessToken: `access-${value}`,
  refreshToken: `refresh-${value}`,
  expiresAt: 123,
});
/** A profile store over a fresh database at `file`. */
const openProfiles = Effect.fn("oauthAccounts.open")(function* (file: string) {
  const services = yield* Layer.build(
    OAuthProfiles.layer.pipe(Layer.provide(Database.layer(file))),
  );
  return Context.get(services, OAuthProfiles);
});
const fixture = Effect.fn("oauthAccounts.fixture")(function* () {
  const profiles = yield* openProfiles(":memory:");
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
  return { profiles, legacy, accounts, legacySecrets, profileSecrets };
});
const selectedIds = (
  profiles: ReadonlyArray<{ readonly id: string; readonly selected: boolean }>,
) => profiles.filter((profile) => profile.selected).map((profile) => profile.id);

describe("OAuth per-profile secret storage and non-destructive migration", () => {
  it.live("two profiles per provider have isolated secrets and secret-free metadata", () =>
    Effect.gen(function* () {
      const { profiles, accounts, profileSecrets } = yield* fixture();
      for (const [index, provider] of providers.entries()) {
        for (const suffix of [1, 2]) {
          const id = `00000000-0000-4000-8000-${String(index * 2 + suffix).padStart(12, "0")}`;
          yield* call(() => accounts.write(provider, id, token(`${provider}-${id}`)));
          yield* profiles.publish(provider, id, `로컬 ${id}`, accounts);
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
      expect(yield* serialize(yield* profiles.list())).not.toContain("access-");
      expect(yield* serialize(yield* profiles.list())).not.toContain("refresh-");
    }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live.each(providers)(
    "copies %s legacy credential, verifies, retains original and survives repeat",
    (provider) =>
      Effect.gen(function* () {
        const { profiles, legacy, accounts, legacySecrets } = yield* fixture();
        yield* call(() => legacy.write(provider, token(provider)));
        const imported = yield* profiles.importLegacy(provider, accounts, legacy);
        expect(imported).toMatchObject({ id: `legacy-${provider}`, provider, selected: true });
        expect(yield* call(() => accounts.read(provider, `legacy-${provider}`))).toEqual(
          token(provider),
        );
        expect(yield* call(() => legacy.read(provider))).toEqual(token(provider));
        expect(yield* profiles.importLegacy(provider, accounts, legacy)).toEqual(imported);
        expect(yield* profiles.list(provider)).toHaveLength(1);
        expect(MutableHashMap.size(legacySecrets)).toBe(1);
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live(
    "a failed copy or readback never publishes metadata or removes legacy; retry succeeds",
    () =>
      Effect.gen(function* () {
        const { profiles, legacy, accounts } = yield* fixture();
        yield* call(() => legacy.write("openai", token("original")));
        const failed = createProfileCredentialStore(() => ({
          read: () => Promise.resolve(null),
          write: () => Promise.reject(new Error("disk unavailable")),
          remove: () => Promise.reject(new Error("must not delete")),
        }));
        yield* rejects(profiles.importLegacy("openai", failed, legacy), "disk unavailable");
        expect(yield* profiles.list()).toEqual([]);
        expect(yield* call(() => legacy.read("openai"))).toEqual(token("original"));
        const noReadback = createProfileCredentialStore(() => ({
          read: () => Promise.resolve(null),
          write: () => Promise.resolve(),
          remove: () => Promise.reject(new Error("must not delete")),
        }));
        yield* rejects(
          profiles.importLegacy("openai", noReadback, legacy),
          "oauth_profile_copy_unverified",
        );
        expect(yield* profiles.list()).toEqual([]);
        expect(yield* profiles.importLegacy("openai", accounts, legacy)).toMatchObject({
          selected: true,
        });
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live(
    "publishes verified accounts without replacing selection; scoped switch persists on reopen",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "oauth-profiles-" });
        const path = pathService.join(directory, "agent.db");
        const { accounts, legacy } = yield* fixture();
        const chosen = "00000000-0000-4000-8000-000000000002";
        yield* Effect.gen(function* () {
          const profiles = yield* openProfiles(path);
          for (const provider of providers) {
            yield* call(() => legacy.write(provider, token(`original-${provider}`)));
            yield* profiles.importLegacy(provider, accounts, legacy);
            for (const suffix of [1, 2]) {
              const id = `00000000-0000-4000-8000-${String((provider === "openai" ? 0 : 2) + suffix).padStart(12, "0")}`;
              yield* call(() => accounts.write(provider, id, token(`${provider}-${suffix}`)));
              expect(
                yield* profiles.publish(provider, id, `계정 ${suffix}`, accounts),
              ).toMatchObject({ selected: false });
            }
          }
          expect(selectedIds(yield* profiles.list("openai"))).toEqual(["legacy-openai"]);
          yield* profiles.select("openai", chosen, accounts);
          expect(selectedIds(yield* profiles.list("openai"))).toEqual([chosen]);
          expect(selectedIds(yield* profiles.list("anthropic"))).toEqual(["legacy-anthropic"]);
          expect(yield* call(() => legacy.read("openai"))).toEqual(token("original-openai"));
        }).pipe(Effect.scoped);
        const reopened = yield* openProfiles(path);
        expect(selectedIds(yield* reopened.list("openai"))).toEqual([chosen]);
        expect(yield* serialize(yield* reopened.list())).not.toContain("access-");
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live(
    "rejects missing credentials, invalid labels and cross-provider selection without altering active profile",
    () =>
      Effect.gen(function* () {
        const { profiles, accounts, legacy } = yield* fixture();
        const id = "00000000-0000-4000-8000-000000000001";
        yield* call(() => legacy.write("openai", token("original")));
        yield* profiles.importLegacy("openai", accounts, legacy);
        yield* rejects(
          profiles.publish("openai", id, "unverified", accounts),
          "missing_credential",
        );
        yield* call(() => accounts.write("openai", id, token("new")));
        yield* rejects(profiles.publish("openai", id, " ", accounts), "invalid_oauth_profile");
        yield* profiles.publish("openai", id, "새 계정", accounts);
        expect((yield* profiles.rename("openai", id, "  두 번째  ")).label).toBe("두 번째");
        yield* rejects(profiles.rename("anthropic", id, "가짜"), "not_found");
        expect((yield* profiles.list("openai")).find((p) => p.id === id)?.label).toBe("두 번째");
        yield* rejects(profiles.select("anthropic", id, accounts), "not_found");
        yield* call(() => accounts.remove("openai", id));
        yield* rejects(profiles.select("openai", id, accounts), "missing_credential");
        expect(selectedIds(yield* profiles.list("openai"))).toEqual(["legacy-openai"]);
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live(
    "removing selected profile chooses an intact fallback and does not touch the other provider",
    () =>
      Effect.gen(function* () {
        const { profiles, legacy, accounts } = yield* fixture();
        for (const provider of providers) {
          yield* call(() => legacy.write(provider, token(`original-${provider}`)));
          yield* profiles.importLegacy(provider, accounts, legacy);
        }
        const first = "00000000-0000-4000-8000-000000000001";
        const second = "00000000-0000-4000-8000-000000000002";
        yield* call(() => accounts.write("openai", first, token("first")));
        yield* call(() => accounts.write("openai", second, token("second")));
        yield* profiles.publish("openai", first, "first", accounts);
        yield* profiles.publish("openai", second, "second", accounts);
        yield* profiles.select("openai", second, accounts);
        yield* rejects(profiles.remove("anthropic", second, accounts, legacy), "not_found");
        const remaining = yield* profiles.remove("openai", second, accounts, legacy);
        expect(remaining.some((profile) => profile.id === second)).toBe(false);
        expect(remaining.filter((profile) => profile.selected)).toHaveLength(1);
        expect(yield* call(() => accounts.read("openai", first))).toEqual(token("first"));
        expect(yield* call(() => accounts.read("openai", second))).toBeNull();
        expect(yield* call(() => legacy.read("openai"))).toEqual(token("original-openai"));
        expect(selectedIds(yield* profiles.list("anthropic"))).toEqual(["legacy-anthropic"]);
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live(
    "explicitly removing legacy account prevents silent re-import even if vault deletion fails",
    () =>
      Effect.gen(function* () {
        const { profiles, legacy, accounts } = yield* fixture();
        yield* call(() => legacy.write("openai", token("original")));
        yield* profiles.importLegacy("openai", accounts, legacy);
        const failed: CredentialStore = {
          read: (provider) => legacy.read(provider),
          write: (provider, value) => legacy.write(provider, value),
          remove: () => Promise.reject(new Error("vault unavailable")),
        };
        yield* rejects(
          profiles.remove("openai", "legacy-openai", accounts, failed),
          "vault unavailable",
        );
        expect(yield* profiles.importLegacy("openai", accounts, legacy)).toBeNull();
        expect(yield* call(() => legacy.read("openai"))).toEqual(token("original"));
        expect(yield* profiles.list("openai")).toHaveLength(1);
        expect(yield* profiles.remove("openai", "legacy-openai", accounts, legacy)).toEqual([]);
        expect(yield* call(() => legacy.read("openai"))).toBeNull();
        expect(yield* call(() => accounts.read("openai", "legacy-openai"))).toBeNull();
        expect(yield* profiles.importLegacy("openai", accounts, legacy)).toBeNull();
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live(
    "a published profile with a missing copied slot is safely restored from intact legacy",
    () =>
      Effect.gen(function* () {
        const { profiles, legacy, accounts } = yield* fixture();
        yield* call(() => legacy.write("openai", token("original")));
        yield* profiles.importLegacy("openai", accounts, legacy);
        yield* call(() => accounts.remove("openai", "legacy-openai"));
        const restored = yield* profiles.importLegacy("openai", accounts, legacy);
        expect(restored).toMatchObject({ id: "legacy-openai", selected: true });
        expect(yield* call(() => accounts.read("openai", "legacy-openai"))).toEqual(
          token("original"),
        );
        expect(yield* call(() => legacy.read("openai"))).toEqual(token("original"));
      }).pipe(Effect.scoped, withTestPlatform),
  );

  it.live("an orphaned conflicting keychain slot is never overwritten", () =>
    Effect.gen(function* () {
      const { profiles, legacy, accounts } = yield* fixture();
      yield* call(() => legacy.write("anthropic", token("legacy")));
      yield* call(() => accounts.write("anthropic", "legacy-anthropic", token("different")));
      yield* rejects(
        profiles.importLegacy("anthropic", accounts, legacy),
        "oauth_profile_conflicting_credential",
      );
      expect(yield* call(() => accounts.read("anthropic", "legacy-anthropic"))).toEqual(
        token("different"),
      );
      expect(yield* call(() => legacy.read("anthropic"))).toEqual(token("legacy"));
      expect(yield* profiles.list()).toEqual([]);
    }).pipe(Effect.scoped, withTestPlatform),
  );
});
