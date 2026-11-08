/**
 * The writable storage assembly for the CLI's import command.
 *
 * Unlike `./read-only-storage.ts`, this one writes: it takes the app's own
 * `<storage>/backend.lock` first, then opens (creating it when absent) and migrates the database,
 * and brings up only what one import pass and the indexing after it need — the services listed in
 * `docs/designs/cli-import.md`. Chat, kanban, tools, providers, MCP, skills and the keychain are
 * left out: a CLI run has no use for them and would pay their background loops.
 *
 * While the app owns the storage folder the layer fails with `StorageLockHeld` instead of taking
 * it: two writers must never open one folder (the read commands keep working regardless).
 */
import { Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { nodePlatformLayer } from "../runtime/node-platform.ts";
import { lockStorageRoot } from "../runtime/storage-lock.ts";
import { path } from "../runtime/synchronous-path.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { GlobalConfig } from "../config/global-config.ts";
import { Database } from "../db/database.ts";
import { AppEvents } from "../events/app-events.ts";
import { Projects } from "../projects/projects.ts";
import { Embedder } from "../memory/embedding/embedder.ts";
import { ModelDownloads } from "../memory/embedding/downloads.ts";
import { nativeVectorIndexLayer } from "../memory/embedding/native-vector-index.ts";
import { Indexer } from "../memory/embedding/indexer.ts";
import { Importer } from "../imports/importer.ts";

/**
 * The import services over one storage folder, held for the layer's scope.
 *
 * `importsHome` names the home directory holding other agents' transcripts (`.claude`, `.codex`);
 * tests pass a synthetic one. The importer never watches here: a CLI run makes one pass and ends,
 * so the background watcher the app runs would only keep the process alive.
 */
export function writableMemoryLayer(options: {
  readonly storage: string;
  readonly importsHome?: string | undefined;
  /** Tests pass a fake embedder; a real run embeds locally with the downloaded model. */
  readonly embedder?: Layer.Layer<Embedder, never, StorageRoot | GlobalConfig | ModelDownloads>;
}) {
  const storage = options.storage;
  return Layer.unwrap(
    Effect.gen(function* () {
      // Before anything opens the database: the lock is what keeps a second writer out, and its
      // finalizer gives it back when this layer's scope closes.
      yield* lockStorageRoot({
        storageRoot: storage,
        // A CLI owner serves no port; the record keeps the app's shape all the same.
        port: 0,
        instanceId: SecureRandom.uuidV4Unsafe(),
      });
      // `Database.layer` creates the folder and the file when they are missing and migrates the
      // schema, which is exactly what a storage folder the app never opened needs.
      const base = Layer.mergeAll(
        StorageRoot.layer(storage),
        Database.layer(path.join(storage, "agent.db")),
        ModelDownloads.layer,
      ).pipe(Layer.provideMerge(nodePlatformLayer));
      const config = GlobalConfig.layer.pipe(Layer.provideMerge(base));
      const stores = Layer.mergeAll(
        AppEvents.layer,
        Projects.layer,
        options.embedder ?? Embedder.local,
      ).pipe(Layer.provideMerge(config));
      const indexing = Indexer.layer.pipe(
        Layer.provideMerge(nativeVectorIndexLayer),
        Layer.provideMerge(stores),
      );
      return Importer.layer(false, options.importsHome).pipe(Layer.provideMerge(indexing));
      // The lock needs a filesystem before any service exists; this assembly is the entry point
      // of the command that uses it.
      // @effect-diagnostics-next-line strictEffectProvide:off
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
}
