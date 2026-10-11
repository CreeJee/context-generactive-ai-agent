// Trusted native bootstrap boundary. Never enable extensions on the user database.
import { DatabaseSync } from "node:sqlite";

/** Bind the addon to Node's SQLite API instead of linking another SQLite in this process. */
export function initializeNodeSqlite(addonPath: string): void {
  const bootstrap = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    bootstrap.loadExtension(addonPath, "sqlite3_turbovec_init");
    bootstrap.enableLoadExtension(false);
  } finally {
    bootstrap.close();
  }
}
