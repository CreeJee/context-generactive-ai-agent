import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, Layer, Path } from "effect";
import { homeDirectory } from "../runtime/host-system.ts";

/** `~/.context-generactive-agent`: database, vector indexes, models and config. */
export const defaultStorageRoot = Effect.runSync(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(NodePath.layer);
      return Context.get(services, Path.Path).join(
        yield* homeDirectory,
        ".context-generactive-agent",
      );
    }),
  ),
);

/** Directory holding the database, vector indexes and global config. Never inside a project. */
export class StorageRoot extends Context.Service<StorageRoot, { readonly path: string }>()(
  "memory-agent/config/storage-root/StorageRoot",
) {
  static readonly layer = (path: string) => Layer.succeed(StorageRoot, { path });
  static readonly home = StorageRoot.layer(defaultStorageRoot);
}
