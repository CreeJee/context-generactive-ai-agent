import { SubscriptionProviderId } from "../providers/contracts.ts";
import { Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthProvider } from "./protocol.ts";
import { beginOAuthProfileRemoval, oauthProfileRemoving } from "./run-leases.ts";
import {
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
export async function publishOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  label: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
): Promise<OAuthProfile> {
  if (!profileIdPattern.test(id) || id.startsWith("legacy-") || !label.trim() || label.length > 80)
    throw new Error("invalid_oauth_profile");
  if (!(await accounts.read(provider, id))) throw new Error("oauth_profile_missing_credential");
  sqlite
    .prepare(`INSERT INTO oauth_profiles(id, provider, label, selected, created_at)
    VALUES (?, ?, ?, 0, ?)`)
    .run(id, provider, label.trim(), Date.now());
  return listOAuthProfiles(sqlite, provider).find((profile) => profile.id === id)!;
}

/** Selection is provider-scoped and committed atomically; vault contents are never copied. */
export async function selectOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
): Promise<OAuthProfile> {
  const target = listOAuthProfiles(sqlite, provider).find((profile) => profile.id === id);
  if (!target) throw new Error("oauth_profile_not_found");
  if (oauthProfileRemoving(sqlite, provider, id)) throw new Error("oauth_profile_removing");
  if (!(await accounts.read(provider, id))) throw new Error("oauth_profile_missing_credential");
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (oauthProfileRemoving(sqlite, provider, id)) throw new Error("oauth_profile_removing");
    if (
      !sqlite
        .prepare("SELECT id FROM oauth_profiles WHERE id = ? AND provider = ?")
        .get(id, provider)
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
  return { ...target, selected: true };
}

export function renameOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  label: string,
): OAuthProfile {
  if (!label.trim() || label.length > 80) throw new Error("invalid_oauth_profile");
  const updated = sqlite
    .prepare("UPDATE oauth_profiles SET label = ? WHERE id = ? AND provider = ?")
    .run(label.trim(), id, provider);
  if (updated.changes !== 1) throw new Error("oauth_profile_not_found");
  return listOAuthProfiles(sqlite, provider).find((item) => item.id === id)!;
}

export async function removeOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy: CredentialStore = createKeychainCredentialStore(),
): Promise<OAuthProfile[]> {
  const profile = listOAuthProfiles(sqlite, provider).find((item) => item.id === id);
  if (!profile) throw new Error("oauth_profile_not_found");
  const finishRemoval = beginOAuthProfileRemoval(sqlite, provider, id);
  try {
    let fallback: OAuthProfile | undefined;
    if (profile.selected) {
      for (const candidate of listOAuthProfiles(sqlite, provider).filter(
        (item) => item.id !== id,
      )) {
        if (await accounts.read(provider, candidate.id)) {
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
        .run(provider, Date.now());
      await legacy.remove(provider);
    }
    await accounts.remove(provider, id);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.prepare("DELETE FROM oauth_profiles WHERE id = ? AND provider = ?").run(id, provider);
      if (fallback)
        sqlite
          .prepare("UPDATE oauth_profiles SET selected = 1 WHERE id = ? AND provider = ?")
          .run(fallback.id, provider);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    return listOAuthProfiles(sqlite, provider);
  } finally {
    finishRemoval();
  }
}

export function listOAuthProfiles(sqlite: DatabaseSync, provider?: OAuthProvider): OAuthProfile[] {
  const rows = provider
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
  const profiles = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        provider: SubscriptionProviderId,
        label: Schema.String,
        selected: Schema.Literals([0, 1]),
        created_at: Schema.Finite,
      }),
    ),
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
export async function importLegacyOAuthProfile(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  accounts: ProfileCredentialStore = createProfileCredentialStore(),
  legacy: CredentialStore = createKeychainCredentialStore(),
): Promise<OAuthProfile | null> {
  const id = `legacy-${provider}`;
  if (sqlite.prepare("SELECT provider FROM oauth_legacy_removed WHERE provider = ?").get(provider))
    return null;
  const existing = listOAuthProfiles(sqlite, provider).find((item) => item.id === id);
  const stored = await accounts.read(provider, id);
  if (existing && stored) return existing;
  const credential = await legacy.read(provider);
  if (!credential) {
    if (existing) throw new Error("oauth_profile_missing_credential");
    return null;
  }
  if (stored && JSON.stringify(stored) !== JSON.stringify(credential))
    throw new Error("oauth_profile_conflicting_credential");
  if (!stored) await accounts.write(provider, id, credential);
  const verified = await accounts.read(provider, id);
  if (!verified || JSON.stringify(verified) !== JSON.stringify(credential))
    throw new Error("oauth_profile_copy_unverified");
  // No asynchronous work in this transaction. A second importer may win; the legacy slot survives either way.
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
        Date.now(),
      );
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  return listOAuthProfiles(sqlite, provider).find((item) => item.id === id) ?? null;
}
