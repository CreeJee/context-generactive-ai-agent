import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import {
  createTextFileEffect,
  deleteTextFileEffect,
  readTextFileEffect,
  replaceTextFileEffect,
} from "../src/files/text.ts";

layer(NodeServices.layer)((it) => {
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
