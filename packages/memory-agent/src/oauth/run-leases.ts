import type { DatabaseSync } from "node:sqlite";
import type { OAuthProvider } from "./protocol.ts";

// Local server process only: no token or account label is retained. SQLite remains the source
// for persisted profiles; this transient guard protects vault removal during a live model run.
const leases = new WeakMap<DatabaseSync, Map<string, number>>();
const removals = new WeakMap<DatabaseSync, Set<string>>();
const key = (provider: OAuthProvider, id: string) => `${provider}:${id}`;

export function acquireOAuthProfileRun(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): () => void {
  if (removals.get(sqlite)?.has(key(provider, id))) throw new Error("oauth_profile_removing");
  let counts = leases.get(sqlite);
  if (!counts) {
    counts = new Map();
    leases.set(sqlite, counts);
  }
  const name = key(provider, id);
  counts.set(name, (counts.get(name) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = counts.get(name) ?? 0;
    if (active <= 1) counts.delete(name);
    else counts.set(name, active - 1);
  };
}

export function oauthProfileInUse(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): boolean {
  return (leases.get(sqlite)?.get(key(provider, id)) ?? 0) > 0;
}

export function oauthProfileRemoving(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): boolean {
  return removals.get(sqlite)?.has(key(provider, id)) ?? false;
}

/** Synchronous admission gate before any asynchronous vault operation. Always release in finally. */
export function beginOAuthProfileRemoval(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): () => void {
  if (oauthProfileInUse(sqlite, provider, id)) throw new Error("oauth_profile_in_use");
  let pending = removals.get(sqlite);
  if (!pending) {
    pending = new Set();
    removals.set(sqlite, pending);
  }
  const name = key(provider, id);
  if ([...pending].some((entry) => entry.startsWith(`${provider}:`)))
    throw new Error("oauth_profile_removing");
  pending.add(name);
  return () => {
    pending.delete(name);
  };
}
