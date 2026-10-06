import { MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthProvider } from "./protocol.ts";

// Local server process only: no token or account label is retained. SQLite remains the source
// for persisted profiles; this transient guard protects vault removal during a live model run.
type ProfileRunState =
  | { readonly status: "active"; readonly count: number }
  | { readonly status: "removing" };
const states = new WeakMap<DatabaseSync, MutableHashMap.MutableHashMap<string, ProfileRunState>>();
const profilesFor = (sqlite: DatabaseSync) => {
  let profiles = states.get(sqlite);
  if (!isTruthy(profiles)) {
    profiles = MutableHashMap.empty();
    states.set(sqlite, profiles);
  }
  return profiles;
};
const key = (provider: OAuthProvider, id: string) => `${provider}:${id}`;

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function acquireOAuthProfileRun(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): () => void {
  const profiles = profilesFor(sqlite);
  const name = key(provider, id);
  const current = Option.getOrUndefined(MutableHashMap.get(profiles, name));
  let count = 0;
  switch (current?.status) {
    case "removing":
      throw new Error("oauth_profile_removing");
    case "active":
      count = current.count;
      break;
    case undefined:
      break;
  }
  MutableHashMap.set(profiles, name, { status: "active", count: count + 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = Option.getOrUndefined(MutableHashMap.get(profiles, name));
    switch (active?.status) {
      case "active":
        if (active.count <= 1) MutableHashMap.remove(profiles, name);
        else MutableHashMap.set(profiles, name, { status: "active", count: active.count - 1 });
        break;
      default:
        break;
    }
  };
}

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function oauthProfileInUse(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): boolean {
  return (
    Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(states.get(sqlite)), (map) =>
        MutableHashMap.get(map, key(provider, id)),
      ),
    )?.status === "active"
  );
}

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function oauthProfileRemoving(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): boolean {
  return (
    Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(states.get(sqlite)), (map) =>
        MutableHashMap.get(map, key(provider, id)),
      ),
    )?.status === "removing"
  );
}

/** Synchronous admission gate before any asynchronous vault operation. Always release in finally. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function beginOAuthProfileRemoval(
  sqlite: DatabaseSync,
  provider: OAuthProvider,
  id: string,
): () => void {
  if (oauthProfileInUse(sqlite, provider, id)) throw new Error("oauth_profile_in_use");
  const profiles = profilesFor(sqlite);
  const name = key(provider, id);
  if (
    [...profiles].some(
      ([entry, state]) => entry.startsWith(`${provider}:`) && state.status === "removing",
    )
  )
    throw new Error("oauth_profile_removing");
  const removing: ProfileRunState = { status: "removing" };
  MutableHashMap.set(profiles, name, removing);
  return () => {
    if (Option.getOrUndefined(MutableHashMap.get(profiles, name)) === removing)
      MutableHashMap.remove(profiles, name);
  };
}
