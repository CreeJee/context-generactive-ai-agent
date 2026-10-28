// Real native handles and SQLite rows exercise the host boundary without module mocks.
import { DatabaseSync } from "node:sqlite";
import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Stream,
} from "effect";
import { connectionContext } from "../src/db/database.ts";
import { createResultPageReader } from "../src/memory/result-pages.ts";
import {
  createTextPageReader,
  linePage,
  maxTextBytes,
  sha256,
  TextFileRejectedReason,
} from "../src/files/text.ts";
import { searchTextFilesEffect } from "../src/files/search.ts";
import { FileTools } from "../src/tools/files.ts";
import { callTool } from "./support/run-tools.ts";
import { listOutsideFilesEffect } from "../src/files/listing.ts";

const resultStore = Effect.acquireRelease(
  Effect.sync(() => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, project_id TEXT, session_id TEXT, text TEXT)",
    );
    return sqlite;
  }),
  (sqlite) => Effect.sync(() => sqlite.close()),
);

// /dev/fd is available on both macOS and Linux. A unique fixture inode avoids other tests' handles.
// stat("/dev/fd/N") reports the devfs device on macOS, so each descriptor is stat'ed directly.
const handlesFor = Effect.fn("handlesFor")(function* (absolute: string) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* fs.stat(absolute);
  const descriptors = yield* fs.readDirectory("/dev/fd");
  const matching = yield* Effect.filter(
    descriptors,
    (name) =>
      fs.statDescriptor(Number(name)).pipe(
        Effect.map(
          (stat) =>
            Option.getOrUndefined(target.ino) === Option.getOrUndefined(stat.ino) &&
            stat.dev === target.dev,
        ),
        // The descriptor used by readDirectory has already closed.
        Effect.catchTag("PlatformError", () => Effect.succeed(false)),
      ),
    { concurrency: "unbounded" },
  );
  return matching.length;
});

/** Waits until the forked reader holds a handle on the fixture. */
const opened = (absolute: string) =>
  Effect.andThen(Effect.yieldNow, handlesFor(absolute)).pipe(
    Effect.repeat({ until: (handles) => handles > 0 }),
  );

layer(NodeServices.layer)((it) => {
  it.effect(
    "saved results page UTF-16 offsets across UTF-8 blocks, NULs and surrogate boundaries",
    () =>
      Effect.gen(function* () {
        const sqlite = yield* resultStore;
        const text = "a".repeat(3999) + "😀\0한글" + "😀abc\r\n".repeat(20000);
        sqlite.prepare("INSERT INTO nodes VALUES ('r', 'tool_result', 'p', 's', ?)").run(text);
        const context = yield* connectionContext(sqlite);
        const reader = yield* Effect.provideContext(createResultPageReader, context);
        expect(yield* reader.read("r", "other", "s", 0)).toBeNull();
        expect(yield* reader.read("r", "p", "other", 0)).toBeNull();
        const pages = yield* Stream.runCollect(
          Stream.paginate(0, (offset) =>
            Effect.map(
              reader.read("r", "p", "s", offset),
              (page) => [Arr.of({ offset, page }), Option.fromNullishOr(page?.nextOffset)] as const,
            ),
          ),
        );
        pages.forEach(({ offset, page }) => {
          expect(page?.offset).toBe(offset);
          expect(page?.length).toBe(text.length);
        });
        expect(pages.map(({ page }) => page?.text).join("")).toBe(text);
        yield* Effect.forEach(
          [3999, 4000, 65535, 100003, text.length + 1],
          (start) =>
            Effect.map(reader.read("r", "p", "s", start), (page) => {
              const begin = Math.min(start, text.length);
              const cut = Math.min(begin + 4000, text.length);
              const last = text.charCodeAt(cut - 1);
              const end =
                cut < text.length && cut - begin > 1 && last >= 0xd800 && last <= 0xdbff
                  ? cut - 1
                  : cut;
              expect(page?.text).toBe(text.slice(begin, end));
            }),
          { discard: true },
        );
        const seeded = yield* Effect.provideContext(createResultPageReader, context);
        yield* seeded.remember("r", text);
        expect(yield* seeded.read("r", "p", "s", 100003)).toEqual(
          yield* reader.read("r", "p", "s", 100003),
        );
        sqlite.prepare("UPDATE nodes SET text = ? WHERE id = 'r'").run("z".repeat(text.length));
        yield* seeded.invalidate;
        expect((yield* seeded.read("r", "p", "s", 100003))?.text).toBe("z".repeat(4000));
        sqlite.exec("DELETE FROM nodes");
        expect(yield* seeded.read("r", "p", "s", 0)).toBeNull();
      }),
  );

  it.effect("line ranges match the original pagination contract and invalidate changed files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const absolute = path.join(directory, "text");
      const reader = yield* createTextPageReader;
      const texts = [
        "",
        "😀\r\n",
        "한글😀\r\n".repeat(20000),
        "😀".repeat(40000) + "\nlast",
        "x\n".repeat(100000),
      ];
      yield* Effect.forEach(
        texts,
        (text) =>
          Effect.andThen(
            fs.writeFileString(absolute, text),
            Effect.forEach(
              [0, 1, 2, 15000, 200001],
              (startLine) =>
                Effect.map(reader({ absolute, path: "text", startLine, maxLines: 2000 }), (page) =>
                  expect(page).toEqual({
                    sha256: sha256(text),
                    ...linePage(text, startLine, 2000),
                  }),
                ),
              { discard: true },
            ),
          ),
        { discard: true },
      );
      yield* fs.writeFile(absolute, new Uint8Array([0xff]));
      expect(
        (yield* Effect.flip(reader({ absolute, path: "text", startLine: 1, maxLines: 1 }))).reason,
      ).toEqual(TextFileRejectedReason.cases.invalid_utf8.make({}));
      yield* fs.writeFileString(absolute, "a".repeat(maxTextBytes + 1));
      expect(
        (yield* Effect.flip(reader({ absolute, path: "text", startLine: 1, maxLines: 1 }))).reason,
      ).toEqual(TextFileRejectedReason.cases.too_large.make({}));
      yield* fs.remove(absolute);
      expect(
        (yield* Effect.flip(reader({ absolute, path: "text", startLine: 1, maxLines: 1 }))).reason,
      ).toMatchObject({ operation: "open", code: "ENOENT" });
    }),
  );

  it.effect(
    "sequential search pages have no repeated or missing lines, including long-line fallback",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const absolute = path.join(directory, "text");
        const text = "İ match 😀\r\n".repeat(700) + "x".repeat(20000) + "match\nlast match";
        yield* fs.writeFileString(absolute, text);
        const reader = yield* createTextPageReader;
        const pages = yield* Stream.runCollect(
          Stream.paginate({ file: 0, line: 0 }, (start) =>
            Effect.map(
              searchTextFilesEffect({
                paths: [absolute],
                query: "MATCH",
                caseSensitive: false,
                start,
                readBytes: () => Effect.succeed(Buffer.from(text)),
                readPage: (_, startLine) =>
                  reader({ absolute, path: absolute, startLine, maxLines: 2000 }),
              }),
              (page) => [Arr.of(page), Option.fromNullishOr(page.next)] as const,
            ),
          ),
        );
        pages.forEach((page) => expect(page.matches.length).toBeLessThanOrEqual(100));
        expect(pages.flatMap((page) => page.matches.map((match) => match.line))).toEqual(
          Array.from({ length: 702 }, (_, index) => index + 1),
        );
      }),
  );

  it.effect("interruption closes native file and directory handles before returning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const absolute = path.join(directory, "text");
      yield* fs.writeFileString(absolute, "x\n".repeat(maxTextBytes / 2));
      const reading = yield* Effect.forkChild(
        Effect.flatMap(createTextPageReader, (reader) =>
          reader({ absolute, path: absolute, startLine: 1, maxLines: 1 }),
        ),
      );
      yield* opened(absolute);
      yield* Fiber.interrupt(reading);
      expect(yield* handlesFor(absolute)).toBe(0);
      yield* Effect.forEach(
        Arr.makeBy(100, (i) => path.join(directory, String(i))),
        (file) => fs.writeFileString(file, "x"),
        { discard: true },
      );
      const listing = yield* Effect.forkChild(listOutsideFilesEffect(directory, undefined));
      yield* opened(directory);
      yield* Fiber.interrupt(listing);
      expect(yield* handlesFor(directory)).toBe(0);
      const complete = yield* listOutsideFilesEffect(directory, undefined);
      expect(complete.paths).toHaveLength(101);
      expect(complete.paths).toEqual([...complete.paths].sort());
    }),
  );
  it.effect("cancellation waits for close and keeps interruption distinct from I/O failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const absolute = path.join(directory, "text");
      yield* fs.writeFileString(absolute, "x\n".repeat(maxTextBytes / 2));
      const files = yield* Effect.provideContext(FileTools, yield* Layer.build(FileTools.layer));
      const tools = files.toolsFor({
        id: "p",
        root: directory,
        name: "fixture",
        crossRecallExcluded: false,
        permissionMode: "ask",
        createdAt: "2026-10-10T00:00:00Z",
        hiddenAt: null,
      });
      const reading = yield* Effect.forkChild(
        callTool(tools, "read_file", { path: "text", maxLines: 1 }),
      );
      yield* opened(absolute);
      yield* Fiber.interrupt(reading);
      expect(yield* handlesFor(absolute)).toBe(0);
      const exit = yield* Fiber.await(reading);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );
});
