import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { expect } from "vite-plus/test";
import { removeStorageLeftovers, StorageRoot } from "./storage-root.ts";

layer(Layer.merge(NodeFileSystem.layer, NodePath.layer))("storage leftovers", (it) => {
  it.effect("removes only the folders earlier versions left behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* Effect.forEach(
        ["goal-worker-assets-0RQdSp", "models/kiwi-0.24.0/models", "models/CreeJee", "vectors"],
        (folder) => fs.makeDirectory(`${root}/${folder}`, { recursive: true }),
      );
      yield* fs.writeFileString(`${root}/goal-worker-assets-0RQdSp/worker.mjs`, "");

      yield* removeStorageLeftovers.pipe(Effect.provideService(StorageRoot, { path: root }));

      expect((yield* fs.readDirectory(root)).toSorted()).toEqual(["models", "vectors"]);
      expect(yield* fs.readDirectory(`${root}/models`)).toEqual(["CreeJee"]);
    }).pipe(Effect.scoped),
  );
});
