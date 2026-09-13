import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Layer } from "effect";

/** `~/.context-generactive-agent`: database, vector indexes, models, codex home and config. */
export const defaultStorageRoot = join(homedir(), ".context-generactive-agent");

/** Directory holding the database, vector indexes and global config. Never inside a project. */
export class StorageRoot extends Context.Tag("memory-agent/StorageRoot")<
  StorageRoot,
  { readonly path: string }
>() {
  static readonly layer = (path: string) => Layer.succeed(StorageRoot, { path });
  static readonly home = StorageRoot.layer(defaultStorageRoot);
}
