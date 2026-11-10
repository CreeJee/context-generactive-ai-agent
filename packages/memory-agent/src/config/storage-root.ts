import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { homeDirectory } from "../runtime/host-system.ts";
import { logFailure } from "../runtime/logged-failures.ts";

/** `~/.context-generactive-agent`: database, vector indexes, models and config. */
export const defaultStorageRoot = Effect.scoped(
  Effect.gen(function* () {
    const services = yield* Layer.build(NodePath.layer);
    return Context.get(services, Path.Path).join(
      yield* homeDirectory,
      ".context-generactive-agent",
    );
  }),
);

/** Directory holding the database, vector indexes and global config. Never inside a project. */
export class StorageRoot extends Context.Service<StorageRoot, { readonly path: string }>()(
  "memory-agent/config/storage-root/StorageRoot",
) {
  static readonly layer = (path: string) => Layer.succeed(StorageRoot, { path });
  static readonly home = Layer.effect(
    StorageRoot,
    Effect.map(defaultStorageRoot, (path) => ({ path })),
  );
}

/**
 * Removes what earlier versions left in the storage root that nothing reads any more: the temporary
 * folders of the removed Goal worker (`goal-worker-assets-*`) and the Kiwi model the memory search
 * no longer loads (`models/kiwi-0.24.0`). Once they are gone it finds nothing; one it cannot
 * remove is logged and stays for the next start.
 */
export const removeStorageLeftovers = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failed = logFailure("storage_leftovers_cleanup_failed");
  const remove = (folder: string) =>
    fs.remove(folder, { recursive: true, force: true }).pipe(Effect.catch(failed));
  yield* fs.readDirectory(storage.path).pipe(
    Effect.map((names) => [
      ...names
        .filter((name) => name.startsWith("goal-worker-assets-"))
        .map((name) => path.join(storage.path, name)),
      path.join(storage.path, "models", "kiwi-0.24.0"),
    ]),
    Effect.flatMap(Effect.forEach(remove, { discard: true })),
    Effect.catch(failed),
  );
});

/** {@link removeStorageLeftovers} in the background of the app's start. */
export const leftoverStorageCleanup = Layer.effectDiscard(
  Effect.forkScoped(removeStorageLeftovers),
);
