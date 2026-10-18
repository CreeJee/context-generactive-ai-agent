// Synthetic local I/O only: node --expose-gc tools/io-range-benchmark.ts
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem, Path } from "effect";
import { connectionContext } from "../packages/memory-agent/src/db/database.ts";
import { createResultPageReader } from "../packages/memory-agent/src/memory/result-pages.ts";
import {
  createTextPageReader,
  linePage,
  readTextFileEffect,
  sha256,
  splitLines,
  linePageOf,
} from "../packages/memory-agent/src/files/text.ts";
import { isCredentialPath } from "../packages/memory-agent/src/files/paths.ts";
import { listOutsideFilesEffect } from "../packages/memory-agent/src/files/listing.ts";
import { searchTextFilesEffect } from "../packages/memory-agent/src/files/search.ts";

const measure = Effect.fnUntraced(function* <A, E, R>(name: string, work: Effect.Effect<A, E, R>) {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    yield* work;
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return {
    name,
    medianMs: Number(samples[2]!.toFixed(3)),
    samplesMs: samples.map((ms) => Number(ms.toFixed(3))),
  };
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "io-range-bench-" });
  const absolute = path.join(directory, "lines");
  const fileText = "match 한글 😀 contents of this line\r\n".repeat(40000);
  yield* fs.writeFileString(absolute, fileText);
  const fileOptions = { absolute, path: "lines" };
  const readPage = createTextPageReader();
  const legacyFile = yield* readTextFileEffect(fileOptions);
  const cachedLines = splitLines(legacyFile.text);
  const sqlite = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(":memory:"),
      catch: (cause) => new Cause.UnknownError(cause),
    }),
    (db) => Effect.sync(() => db.close()),
  );
  sqlite.exec(
    "CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, project_id TEXT, session_id TEXT, text TEXT)",
  );
  const resultText = "match 한글 😀\r\n".repeat(400000);
  sqlite.prepare("INSERT INTO nodes VALUES ('r', 'tool_result', 'p', 's', ?)").run(resultText);
  const oldResult = sqlite.prepare("SELECT * FROM nodes WHERE id = 'r'");
  const context = yield* connectionContext(sqlite);
  const resultReader = yield* Effect.provideContext(createResultPageReader, context);
  const rows = [];
  rows.push(
    yield* measure(
      "result old: 100 pages, two SELECT * per page",
      Effect.gen(function* () {
        for (let page = 0; page < 100; page++) {
          oldResult.get();
          const row = oldResult.get();
          if (row === undefined) return yield* new Cause.UnknownError("missing fixture");
          // SQLite DTO boundary: the fixture column is known text.
          const text = String(row.text);
          text.slice(page * 4000, page * 4000 + 4000);
          yield* Effect.yieldNow;
        }
      }),
    ),
  );
  rows.push(
    yield* measure(
      "result old: first page, two SELECT *",
      Effect.sync(() => {
        oldResult.get();
        const row = oldResult.get();
        return String(row?.text).slice(0, 4000);
      }),
    ),
  );
  rows.push(
    yield* measure(
      "result new: cold historical first page",
      Effect.gen(function* () {
        resultReader.invalidate();
        yield* resultReader.read("r", "p", "s", 0);
      }),
    ),
  );
  rows.push(
    yield* measure(
      "result new: 100 warm pages",
      Effect.gen(function* () {
        for (let page = 0; page < 100; page++) yield* resultReader.read("r", "p", "s", page * 4000);
      }),
    ),
  );
  const savedReader = yield* Effect.provideContext(createResultPageReader, context);
  rows.push(
    yield* measure(
      "result new: index at save",
      Effect.sync(() => savedReader.remember("r", resultText)),
    ),
  );
  rows.push(
    yield* measure(
      "result new: freshly saved first page (index at save)",
      Effect.gen(function* () {
        yield* savedReader.read("r", "p", "s", 0);
      }),
    ),
  );
  rows.push(
    yield* measure(
      "outside old: 50 repeated full reads + line slicing",
      Effect.gen(function* () {
        for (let page = 0; page < 50; page++) {
          const bytes = yield* Effect.tryPromise({
            try: (signal) => readFile(absolute, { signal }),
            catch: (cause) => new Cause.UnknownError(cause),
          });
          const file = {
            text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
            sha256: sha256(bytes),
          };
          linePage(file.text, page * 100 + 1, 100);
        }
      }),
    ),
  );
  yield* readPage({ ...fileOptions, startLine: 1, maxLines: 100 });
  rows.push(
    yield* measure(
      "file new: 50 warm range pages",
      Effect.gen(function* () {
        for (let page = 0; page < 50; page++)
          yield* readPage({ ...fileOptions, startLine: page * 100 + 1, maxLines: 100 });
      }),
    ),
  );
  rows.push(
    yield* measure(
      "project old: 50 warm cached line slices",
      Effect.sync(() => {
        for (let page = 0; page < 50; page++) linePageOf(cachedLines, page * 100 + 1, 100);
      }),
    ),
  );
  const input = {
    paths: [absolute],
    query: "match",
    caseSensitive: true,
    start: { file: 0, line: 0 },
    readBytes: () => fs.readFile(absolute).pipe(Effect.orDie),
  };
  rows.push(
    yield* measure(
      "search old: 50 pages, full file per page",
      Effect.gen(function* () {
        for (let page = 0; page < 50; page++)
          yield* searchTextFilesEffect({ ...input, start: { file: 0, line: page * 100 } });
      }),
    ),
  );
  rows.push(
    yield* measure(
      "search new: 50 pages, bounded line ranges",
      Effect.gen(function* () {
        for (let page = 0; page < 50; page++)
          yield* searchTextFilesEffect({
            ...input,
            start: { file: 0, line: page * 100 },
            readPage: (_, startLine) => readPage({ ...fileOptions, startLine, maxLines: 2000 }),
          });
      }),
    ),
  );
  const tree = path.join(directory, "tree");
  yield* fs.makeDirectory(tree);
  yield* Effect.forEach(
    Array.from({ length: 3500 }, (_, i) => String(i)),
    (name) => fs.writeFileString(path.join(tree, name), ""),
    { concurrency: 16, discard: true },
  );
  rows.push(
    yield* measure(
      "directory old: 3500 entries, readdir array + fixed sorted snapshot",
      Effect.gen(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(tree, { withFileTypes: true }),
          catch: (cause) => new Cause.UnknownError(cause),
        });
        entries
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(tree, entry.name))
          .filter((name) => !isCredentialPath(name))
          .sort();
      }),
    ),
  );
  rows.push(
    yield* measure(
      "directory new: 3500 entries, scoped opendir + fixed sorted snapshot",
      listOutsideFilesEffect(tree, undefined),
    ),
  );
  yield* Console.log(
    JSON.stringify(
      {
        directoryEntries: 3500,
        resultBytes: Buffer.byteLength(resultText),
        fileBytes: Buffer.byteLength(fileText),
        resultPageTransferBoundBytes: 2 * (65536 + 4),
        filePageReadBoundBytes: 64004,
        cachedLineIndexBytes: 40000 * 4,
        rows,
      },
      null,
      2,
    ),
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
