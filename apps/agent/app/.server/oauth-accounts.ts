import type { DatabaseSync } from "node:sqlite";
import { createOAuthAccountLoginManager } from "memory-agent";

const managers = new WeakMap<DatabaseSync, ReturnType<typeof createOAuthAccountLoginManager>>();

/** One pending OAuth callback per provider, scoped to the app's SQLite instance. */
export function accountLoginManager(
  sqlite: DatabaseSync,
): ReturnType<typeof createOAuthAccountLoginManager> {
  let manager = managers.get(sqlite);
  if (!manager) {
    manager = createOAuthAccountLoginManager(sqlite);
    managers.set(sqlite, manager);
  }
  return manager;
}
