import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";
import { expect } from "vite-plus/test";

it.live(
  "lstat inspects links themselves, including dangling links, and preserves file metadata",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "effect-lstat-" });
      const file = path.join(root, "file.txt");
      const link = path.join(root, "link");
      const dangling = path.join(root, "dangling");
      yield* fs.writeFileString(file, "hello");
      yield* fs.symlink(file, link);
      yield* fs.symlink(path.join(root, "missing"), dangling);
      const info = yield* fs.lstat(file);
      expect(info.type).toBe("File");
      expect(info.size).toBe(5n);
      expect(Option.getOrUndefined(info.nlink)).toBe(1);
      expect(info.ino).toEqual((yield* fs.stat(file)).ino);
      expect((yield* fs.lstat(root)).type).toBe("Directory");
      expect((yield* fs.lstat(link)).type).toBe("SymbolicLink");
      expect((yield* fs.stat(link)).type).toBe("File");
      expect((yield* fs.lstat(dangling)).type).toBe("SymbolicLink");
      const missing = yield* fs.lstat(path.join(root, "missing")).pipe(Effect.flip);
      expect(missing.reason._tag).toBe("NotFound");
      expect(missing.reason.method).toBe("lstat");
      const noop = yield* FileSystem.makeNoop({}).lstat(file).pipe(Effect.flip);
      expect(noop.reason._tag).toBe("NotFound");
      expect(noop.reason.method).toBe("lstat");
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
);
