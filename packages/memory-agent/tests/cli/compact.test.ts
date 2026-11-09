import { DatabaseSync } from "node:sqlite";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Schema } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { compactStorage } from "../../src/cli/compact.ts";
import { StorageLockHeld, lockStorageRoot } from "../../src/runtime/storage-lock.ts";

/** A storage folder whose database was made before new files returned their free pages. */
const olderStorage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storage = yield* fs.makeTempDirectoryScoped();
  const file = path.join(storage, "agent.db");
  yield* Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(file)),
    (sqlite) =>
      Effect.sync(() => {
        // A table before WAL keeps the file's auto_vacuum at 0, as files made before 2026-11-04.
        sqlite.exec("CREATE TABLE filler(text TEXT)");
        sqlite.exec("PRAGMA journal_mode = WAL");
        sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
          INSERT INTO filler SELECT printf('%.2000c', 'x') FROM n`);
        sqlite.exec("DELETE FROM filler");
      }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );
  return storage;
});

layer(NodeServices.layer)((it) => {
  it.effect("rewrites an older database without its free pages, in incremental mode", () =>
    Effect.gen(function* () {
      const storage = yield* olderStorage;
      const result = yield* Effect.scoped(compactStorage(storage));
      expect(result.before.incremental).toBe(false);
      // The migrations at open reuse some of the 4 MB the filler left.
      expect(result.before.freeBytes).toBeGreaterThan(1_000_000);
      expect(result.after.incremental).toBe(true);
      expect(result.after.freeBytes).toBe(0);
      expect(result.after.bytes).toBeLessThan(result.before.bytes - result.before.freeBytes / 2);
      // The lock went back with the command.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(storage, "backend.lock"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses while another backend owns the storage", () =>
    Effect.gen(function* () {
      const storage = yield* olderStorage;
      yield* lockStorageRoot({ storageRoot: storage, port: 5173, instanceId: "app-under-test" });
      const refused = yield* Effect.flip(Effect.scoped(compactStorage(storage)));
      if (!Schema.is(StorageLockHeld)(refused))
        return expect.unreachable("the compaction was refused for another reason");
      expect(refused.instanceId).toBe("app-under-test");
    }).pipe(Effect.scoped),
  );
});
