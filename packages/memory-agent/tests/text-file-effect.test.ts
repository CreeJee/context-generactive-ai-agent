import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import {
  createTextFileEffect,
  deleteTextFileEffect,
  readTextFileEffect,
  readFileBytesEffect,
  replaceTextFileEffect,
  FileReadPlatform,
} from "../src/files/text.ts";

layer(NodeServices.layer)((it) => {
  it.effect("Windows native boundary reads, replaces and deletes ordinary files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const options = { absolute: path.join(directory, "note.txt"), path: "note.txt" };
      const content = "a".repeat(64 * 1024) + "b".repeat(64 * 1024) + "tail";
      const created = yield* createTextFileEffect({ ...options, text: content });
      expect((yield* readTextFileEffect(options)).text).toBe(content);
      const replaced = yield* replaceTextFileEffect({
        ...options,
        expectedSha256: created.sha256,
        text: "after",
      });
      expect((yield* readTextFileEffect(options)).text).toBe("after");
      yield* deleteTextFileEffect({ ...options, expectedSha256: replaced.sha256 });
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.provideService(FileReadPlatform, "windows")),
  );

  it.effect("Windows native boundary rejects observed symlinks and checked hard links", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const original = path.join(directory, "source.txt");
      yield* fs.writeFileString(original, "secret");
      const symbolic = path.join(directory, "symbolic.txt");
      yield* fs.symlink(original, symbolic);
      expect(
        yield* Effect.result(readFileBytesEffect({ absolute: symbolic, path: "symbolic.txt" })),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "PathRejected", reason: "symlink" } });
      const hard = path.join(directory, "hard.txt");
      yield* fs.link(original, hard);
      expect(
        yield* Effect.result(
          readFileBytesEffect({ absolute: hard, path: "hard.txt", checkLeaf: true }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "PathRejected", reason: "hard_link" } });
      // Skills intentionally permit hard-linked ordinary files when checkLeaf is false.
      expect(
        (yield* readFileBytesEffect({ absolute: hard, path: "hard.txt" })).bytes.toString(),
      ).toBe("secret");
    }).pipe(Effect.provideService(FileReadPlatform, "windows")),
  );

  it.effect("bounded positional reads preserve multiple chunks and reject linked leaves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const absolute = path.join(directory, "source.txt");
      const contents = "a".repeat(64 * 1024) + "b".repeat(64 * 1024) + "tail";
      yield* fs.writeFileString(absolute, contents);
      const result = yield* readFileBytesEffect({ absolute, path: "source.txt", checkLeaf: true });
      expect(result.bytes.toString("utf8")).toBe(contents);
      const symbolic = path.join(directory, "symbolic.txt");
      yield* fs.symlink(absolute, symbolic);
      expect(
        yield* Effect.result(readFileBytesEffect({ absolute: symbolic, path: "symbolic.txt" })),
      ).toMatchObject(
        (yield* FileReadPlatform) === "windows"
          ? { _tag: "Failure", failure: { _tag: "PathRejected", reason: "symlink" } }
          : {
              _tag: "Failure",
              failure: { _tag: "TextFileIoFailed", reason: { operation: "open" } },
            },
      );
      const hard = path.join(directory, "hard.txt");
      yield* fs.link(absolute, hard);
      expect(
        yield* Effect.result(
          readFileBytesEffect({ absolute: hard, path: "hard.txt", checkLeaf: true }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "PathRejected", reason: "hard_link" } });
    }),
  );

  it.effect(
    "typed stale edits preserve content and successful replacement keeps no temporary file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const absolute = path.join(directory, "note.txt");
        const options = { absolute, path: "note.txt" };
        const created = yield* createTextFileEffect({ ...options, text: "before" });
        yield* replaceTextFileEffect({ ...options, expectedSha256: created.sha256, text: "after" });
        const stale = yield* Effect.result(
          replaceTextFileEffect({
            ...options,
            expectedSha256: created.sha256,
            text: "lost update",
          }),
        );
        expect(stale).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TextFileRejected", reason: { _tag: "changed" } },
        });
        const current = yield* readTextFileEffect(options);
        expect(current.text).toBe("after");
        expect(yield* fs.readDirectory(directory)).toEqual(["note.txt"]);
        yield* deleteTextFileEffect({ ...options, expectedSha256: current.sha256 });
        expect(yield* fs.readDirectory(directory)).toEqual([]);
      }),
  );

  it.effect("missing and invalid text files fail in the typed error channel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const absolute = path.join(directory, "note.txt");
      const options = { absolute, path: "note.txt" };
      expect(yield* Effect.result(readTextFileEffect(options))).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "TextFileIoFailed",
          path: "note.txt",
          reason: { _tag: "IoFailed", operation: "open", code: "ENOENT" },
        },
      });
      yield* fs.writeFile(absolute, new Uint8Array([0xff]));
      expect(yield* Effect.result(readTextFileEffect(options))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TextFileRejected", reason: { _tag: "invalid_utf8" } },
      });
      yield* fs.writeFileString(absolute, "existing");
      expect(
        yield* Effect.result(createTextFileEffect({ ...options, text: "overwrite" })),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TextFileRejected", reason: { _tag: "exists" } },
      });
      expect(yield* fs.readFileString(absolute)).toBe("existing");
    }),
  );
});
