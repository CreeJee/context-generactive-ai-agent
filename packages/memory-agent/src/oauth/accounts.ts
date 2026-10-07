import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Cause, Effect, Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";
import { DateTime, Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthProvider } from "./protocol.ts";
import { beginOAuthProfileRemoval, oauthProfileRemoving } from "./run-leases.ts";
import {
  StoredCredentialSchema,
  createKeychainCredentialStore,
  createKeychainProfileCredentialStore,
  type CredentialStore,
  type StoredCredential,
} from "./validation-harness.ts";

export interface OAuthProfile {
  readonly id: string;
  readonly provider: OAuthProvider;
  readonly label: string;
  readonly selected: boolean;
  readonly createdAt: number;
}

export interface ProfileCredentialStore {
  read(provider: OAuthProvider, id: string): Promise<StoredCredential | null>;
  write(provider: OAuthProvider, id: string, credential: StoredCredential): Promise<void>;
  remove(provider: OAuthProvider, id: string): Promise<void>;
}

/** A distinct OS keychain account per local profile; never place credentials in SQLite. */
export function createProfileCredentialStore(
  open: (id: string) => CredentialStore = createKeychainProfileCredentialStore,
): ProfileCredentialStore {
  return {
    read: (provider, id) => open(id).read(provider),
    write: (provider, id, credential) => open(id).write(provider, credential),
    remove: (provider, id) => open(id).remove(provider),
  };
}

const profileIdPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|legacy-(?:openai|anthropic))$/;

/** Publish an already-authenticated per-profile vault slot; leave the current selection untouched. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const publishOAuthProfileEffect = Effect.fn("publishOAuthProfile")(function* (
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  label: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
) {
  if (
    !profileIdPattern.test(id) ||
    id.startsWith("legacy-") ||
    !isTruthy(label.trim()) ||
    label.length > 80
  )
    return yield* new Cause.UnknownError(new Error("invalid_oauth_profile"));
  if (!isTruthy(yield* nativePromise(() => accounts.read(provider, id))))
    return yield* new Cause.UnknownError(new Error("oauth_profile_missing_credential"));
  sqlite
    .prepare(`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
    VALUES (?, ?, ?, 0, ?)`)
    .run(id, provider, label.trim(), DateTime.toEpochMillis(DateTime.nowUnsafe()));
  return listOAuthProfiles(sqlite, provider).find((profile) => profile.id === id)!;
});

export function publishOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  label: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
): Promise<OAuthProfile> {
  return runNativeEffect(publishOAuthProfileEffect(sqlite, provider, id, label, accounts));
}

/** Selection is provider-scoped and committed atomically; vault contents are never copied. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const selectOAuthProfileEffect = Effect.fn("selectOAuthProfile")(function* (
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
) {
  const target = listOAuthProfiles(sqlite, provider).find((profile) => profile.id === id);
  if (!isTruthy(target)) return yield* new Cause.UnknownError(new Error("oauth_profile_not_found"));
  if (oauthProfileRemoving(sqlite, provider, id))
    return yield* new Cause.UnknownError(new Error("oauth_profile_removing"));
  if (!isTruthy(yield* nativePromise(() => accounts.read(provider, id))))
    return yield* new Cause.UnknownError(new Error("oauth_profile_missing_credential"));
  yield* Effect.try(() => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (oauthProfileRemoving(sqlite, provider, id)) throw new Error("oauth_profile_removing");
      if (
        !isTruthy(
          sqlite
            .prepare("SELECT id FROM oauth_profiles WHERE id = ? AND provider = ?")
            .get(id, provider),
        )
      )
        throw new Error("oauth_profile_not_found");
      sqlite
        .prepare("UPDATE oauth_profiles SET selected = 0 WHERE provider = ? AND selected = 1")
        .run(provider);
      sqlite
        .prepare("UPDATE oauth_profiles SET selected = 1 WHERE provider = ? AND id = ?")
        .run(provider, id);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  });
  return { ...target, selected: true };
});

export function selectOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
): Promise<OAuthProfile> {
  return runNativeEffect(selectOAuthProfileEffect(sqlite, provider, id, accounts));
}

export const renameOAuthProfile: {
  (
    provider: OAuthProvider,
    id: string,
    label: string,
  ): (sqlite: DatabaseSync) => ReturnType<typeof renameOAuthProfileBody>;
} & typeof renameOAuthProfileBody = EffectFunction.dual(4, renameOAuthProfileBody);
function renameOAuthProfileBody(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  label: string,
): OAuthProfile {
  if (!isTruthy(label.trim()) || label.length > 80) throw new Error("invalid_oauth_profile");
  const updated = sqlite
    .prepare("UPDATE oauth_profiles SET label = ? WHERE id = ? AND provider = ?")
    .run(label.trim(), id, provider);
  if (updated.changes !== 1) throw new Error("oauth_profile_not_found");
  return listOAuthProfiles(sqlite, provider).find((item) => item.id === id)!;
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const removeOAuthProfileEffect = Effect.fn("removeOAuthProfile")(function* (
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy: CredentialStore = createKeychainCredentialStore(),
) {
  const profile = listOAuthProfiles(sqlite, provider).find((item) => item.id === id);
  if (!isTruthy(profile))
    return yield* new Cause.UnknownError(new Error("oauth_profile_not_found"));
  const finishRemoval = beginOAuthProfileRemoval(sqlite, provider, id);
  return yield* Effect.gen(function* () {
    let fallback: OAuthProfile | undefined;
    if (profile.selected) {
      for (const candidate of listOAuthProfiles(sqlite, provider).filter(
        (item) => item.id !== id,
      )) {
        if (isTruthy(yield* nativePromise(() => accounts.read(provider, candidate.id)))) {
          fallback = candidate;
          break;
        }
      }
    }
    if (id === `legacy-${provider}`) {
      // Persist explicit removal before touching either vault slot: auth polling must not
      // re-import the legacy credential if a keychain operation fails mid-removal.
      sqlite
        .prepare("INSERT OR IGNORE INTO oauth_legacy_removed(provider, removed_at) VALUES (?, ?)")
        .run(provider, DateTime.toEpochMillis(DateTime.nowUnsafe()));
      yield* nativePromise(() => legacy.remove(provider));
    }
    yield* nativePromise(() => accounts.remove(provider, id));
    yield* Effect.try(() => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        sqlite
          .prepare("DELETE FROM oauth_profiles WHERE id = ? AND provider = ?")
          .run(id, provider);
        if (fallback !== undefined)
          sqlite
            .prepare("UPDATE oauth_profiles SET selected = 1 WHERE id = ? AND provider = ?")
            .run(fallback.id, provider);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    });
    return listOAuthProfiles(sqlite, provider);
  }).pipe(Effect.ensuring(Effect.sync(finishRemoval)));
});

export function removeOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy: CredentialStore = createKeychainCredentialStore(),
): Promise<OAuthProfile[]> {
  return runNativeEffect(removeOAuthProfileEffect(sqlite, provider, id, accounts, legacy));
}

export function listOAuthProfiles(sqlite: DatabaseSync, provider?: OAuthProvider): OAuthProfile[] {
  const rows = isTruthy(provider)
    ? sqlite
        .prepare(
          "SELECT id, provider, label, selected, created_at FROM oauth_profiles WHERE provider = ? ORDER BY created_at, id",
        )
        .all(provider)
    : sqlite
        .prepare(
          "SELECT id, provider, label, selected, created_at FROM oauth_profiles ORDER BY provider, created_at, id",
        )
        .all();
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const profiles = EffectFunction.flow(
    Schema.decodeUnknownResult(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          provider: SubscriptionAccountProvider,
          label: Schema.String,
          selected: Schema.Literals([0, 1]),
          created_at: Schema.Finite,
        }),
      ),
    ),
    Result.getOrThrow,
  )(rows);
  return profiles.map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    selected: row.selected === 1,
    createdAt: row.created_at,
  }));
}

/** Copy first, verify the new slot, then publish secret-free metadata. Never delete the legacy slot. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const importLegacyOAuthProfileEffect = Effect.fn("importLegacyOAuthProfile")(function* (
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy: CredentialStore = createKeychainCredentialStore(),
) {
  const id = `legacy-${provider}`;
  if (
    isTruthy(
      sqlite.prepare("SELECT provider FROM oauth_legacy_removed WHERE provider = ?").get(provider),
    )
  )
    return null;
  const existing = listOAuthProfiles(sqlite, provider).find((item) => item.id === id);
  const stored = yield* nativePromise(() => accounts.read(provider, id));
  if (isTruthy(existing) && isTruthy(stored)) return existing;
  const credential = yield* nativePromise(() => legacy.read(provider));
  if (!isTruthy(credential)) {
    if (isTruthy(existing))
      return yield* new Cause.UnknownError(new Error("oauth_profile_missing_credential"));
    return null;
  }
  if (
    isTruthy(stored) &&
    (yield* Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema))(stored)) !==
      (yield* Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema))(credential))
  )
    return yield* new Cause.UnknownError(new Error("oauth_profile_conflicting_credential"));
  if (!isTruthy(stored)) yield* nativePromise(() => accounts.write(provider, id, credential));
  const verified = yield* nativePromise(() => accounts.read(provider, id));
  if (
    !isTruthy(verified) ||
    (yield* Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema))(verified)) !==
      (yield* Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema))(credential))
  )
    return yield* new Cause.UnknownError(new Error("oauth_profile_copy_unverified"));
  // No asynchronous work in this transaction. A second importer may win; the legacy slot survives either way.
  yield* Effect.try(() => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite
        .prepare(`INSERT OR IGNORE INTO oauth_profiles(id, provider, label, selected, created_at)
      VALUES (?, ?, ?, ?, ?)`)
        .run(
          id,
          provider,
          `${provider === "openai" ? "ChatGPT" : "Claude"} (이전 계정)`,
          listOAuthProfiles(sqlite, provider).some((item) => item.selected) ? 0 : 1,
          DateTime.toEpochMillis(DateTime.nowUnsafe()),
        );
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  });
  return listOAuthProfiles(sqlite, provider).find((item) => item.id === id) ?? null;
});

export function importLegacyOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy: CredentialStore = createKeychainCredentialStore(),
): Promise<OAuthProfile | null> {
  return runNativeEffect(importLegacyOAuthProfileEffect(sqlite, provider, accounts, legacy));
}
