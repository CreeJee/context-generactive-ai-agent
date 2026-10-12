import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import { Hex } from "effect/encoding";
import {
  Context as PlatformContext,
  Effect as PlatformEffect,
  Layer as PlatformLayer,
  Crypto,
  FileSystem,
  Path,
} from "effect";
import { Function as EffectFunction } from "effect";
// Editable snapshots still need same-FD identity and nanosecond-stat checks.
import { constants } from "node:fs";
// Positional reads and nanosecond fstat share that same scoped no-follow handle.
import { lstat, open } from "node:fs/promises";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, MutableHashMap, Option, Schema } from "effect";
import { PathRejected } from "./paths.ts";

// Path operations remain synchronous at these public host boundaries.
const { basename, dirname, join } = PlatformEffect.runSync(
  PlatformEffect.scoped(
    PlatformEffect.gen(function* () {
      const services = yield* PlatformLayer.build(NodePath.layer);
      return PlatformContext.get(services, Path.Path);
    }),
  ),
);

// NodeCrypto's digest and UUID primitives execute synchronously at host API boundaries.
const hostCrypto = PlatformEffect.runSync(
  PlatformEffect.scoped(
    PlatformEffect.gen(function* () {
      const services = yield* PlatformLayer.build(NodeCrypto.layer);
      return PlatformContext.get(services, Crypto.Crypto);
    }),
  ),
);

const fileSystem = PlatformEffect.runSync(
  PlatformEffect.scoped(
    PlatformEffect.gen(function* () {
      const services = yield* PlatformLayer.build(NodeFileSystem.layer);
      return PlatformContext.get(services, FileSystem.FileSystem);
    }),
  ),
);

// A Reference makes the OS boundary testable without changing the host platform globally.
export const FileReadPlatform = PlatformContext.Reference<"windows" | "posix">(
  "memory-agent/files/FileReadPlatform",
  { defaultValue: () => (process.platform === "win32" ? "windows" : "posix") },
);

/** Largest text file the file tools read, search or rewrite. */
export const maxTextBytes = 2 * 1024 * 1024;

/**
 * A file that is not editable text: over {@link maxTextBytes}, containing NUL bytes, or not UTF-8.
 * `changed` means its content no longer matches the version the caller last read.
 */
export class TextFileRejected extends Schema.TaggedError<TextFileRejected>()("TextFileRejected", {
  path: Schema.String,
  reason: Schema.Union([
    Schema.TaggedStruct("too_large", {}),
    Schema.TaggedStruct("binary", {}),
    Schema.TaggedStruct("invalid_utf8", {}),
    Schema.TaggedStruct("changed", {}),
    Schema.TaggedStruct("exists", {}),
  ]),
}) {}

export class TextFileIoFailed extends Schema.TaggedError<TextFileIoFailed>()("TextFileIoFailed", {
  path: Schema.String,
  reason: Schema.TaggedStruct("IoFailed", {
    operation: Schema.Literals([
      "open",
      "stat",
      "read",
      "mkdir",
      "write",
      "sync",
      "close",
      "rename",
      "remove",
    ]),
    code: Schema.String,
    cause: Schema.Defect(),
  }),
}) {}

const systemCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));
// Effect File.Info does not expose this edit boundary's nanosecond file identity.
const io = <A>(
  path: string,
  operation: TextFileIoFailed["reason"]["operation"],
  work: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      TextFileIoFailed.make({
        path,
        reason: {
          _tag: "IoFailed",
          operation,
          code: Option.getOrUndefined(systemCode(cause))?.code ?? "unknown",
          cause,
        },
      }),
  });

const fileIo = <A, R>(
  path: string,
  operation: TextFileIoFailed["reason"]["operation"],
  program: Effect.Effect<A, import("effect/PlatformError").PlatformError, R>,
) =>
  program.pipe(
    Effect.mapError((error) => {
      const cause = error.reason.cause ?? error;
      return TextFileIoFailed.make({
        path,
        reason: {
          _tag: "IoFailed",
          operation,
          code: Option.getOrUndefined(systemCode(cause))?.code ?? "unknown",
          cause,
        },
      });
    }),
  );

export interface TextFile {
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Permission bits, kept when the file is rewritten. */
  readonly mode: number;
}

export { sha256 } from "../runtime/synchronous-crypto.ts";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isAlreadyExists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));

/** A file's raw bytes, with a rejected linked leaf and at most {@link maxTextBytes}. */
export interface FileBytes {
  readonly bytes: Buffer;
  readonly mode: number;
}

/**
 * Reads raw bytes (no text checks). Throws {@link TextFileRejected} `too_large`. With `checkLeaf`,
 * the opened file itself must be a regular file with one link, checked on the handle (for callers
 * that validated the directories but not the file).
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
interface FileReadOptions {
  readonly absolute: string;
  readonly path: string;
  readonly checkLeaf?: boolean;
}

// Windows has no O_NOFOLLOW. Keep native positional reads, fstat and typed close errors.
// lstat rejects an observed linked leaf; this does not provide POSIX's atomic no-follow guarantee.
const readWindowsFileBytes = Effect.fn("readWindowsFileBytes")(function* (
  options: FileReadOptions,
) {
  const { absolute, path, checkLeaf = false } = options;
  const leaf = yield* io(path, "open", () => lstat(absolute));
  if (leaf.isSymbolicLink()) return yield* new PathRejected({ path, reason: "symlink" });
  return yield* Effect.acquireUseRelease(
    io(path, "open", () => open(absolute, constants.O_RDONLY)),
    Effect.fnUntraced(function* (handle) {
      const stats = yield* io(path, "stat", () => handle.stat());
      if (checkLeaf && !stats.isFile())
        return yield* new PathRejected({ path, reason: "not_file" });
      if (checkLeaf && stats.nlink !== 1)
        return yield* new PathRejected({ path, reason: "hard_link" });
      if (stats.size > maxTextBytes)
        return yield* TextFileRejected.make({ path, reason: { _tag: "too_large" } });
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxTextBytes + 1 - size));
        const { bytesRead } = yield* Effect.uninterruptible(
          io(path, "read", () => handle.read(buffer, 0, buffer.length, size)),
        );
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > maxTextBytes)
          return yield* TextFileRejected.make({ path, reason: { _tag: "too_large" } });
        chunks.push(buffer.subarray(0, bytesRead));
        yield* Effect.yieldNow;
      }
      return { bytes: Buffer.concat(chunks, size), mode: stats.mode & 0o7777 };
    }),
    (handle) => io(path, "close", () => handle.close()),
  );
});

const readPosixFileBytes = Effect.fn("readPosixFileBytes")(function* (options: FileReadOptions) {
  const { absolute, path, checkLeaf = false } = options;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileIo(path, "open", fileSystem.open(absolute, { noFollow: true }));
      const stats = yield* fileIo(path, "stat", handle.stat);
      if (checkLeaf && stats.type !== "File")
        return yield* new PathRejected({ path, reason: "not_file" });
      if (checkLeaf && Option.getOrUndefined(stats.nlink) !== 1)
        return yield* new PathRejected({ path, reason: "hard_link" });
      if (stats.size > BigInt(maxTextBytes))
        return yield* TextFileRejected.make({ path, reason: { _tag: "too_large" } });
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxTextBytes + 1 - size));
        const read = yield* Effect.uninterruptible(
          fileIo(path, "read", handle.read(buffer, { position: BigInt(size) })),
        );
        if (read === 0) break;
        size += read;
        if (size > maxTextBytes)
          return yield* TextFileRejected.make({ path, reason: { _tag: "too_large" } });
        chunks.push(buffer.subarray(0, read));
        yield* Effect.yieldNow;
      }
      const bytes = Buffer.concat(chunks, size);
      return { bytes, mode: stats.mode & 0o7777 };
    }),
  );
});

export const readFileBytesEffect = Effect.fn("readFileBytes")(function* (options: FileReadOptions) {
  switch (yield* FileReadPlatform) {
    case "windows":
      return yield* readWindowsFileBytes(options);
    case "posix":
      return yield* readPosixFileBytes(options);
  }
});

export const readFileBytes: {
  (path: string, checkLeaf?: boolean): (absolute: string) => Promise<FileBytes>;
  (absolute: string, path: string, checkLeaf?: boolean): Promise<FileBytes>;
} = EffectFunction.dual(
  (args) => Schema.is(Schema.String)(args[1]),
  (absolute: string, path: string, checkLeaf = false) =>
    Effect.runPromise(readFileBytesEffect({ absolute, path, checkLeaf })),
);

/** Decodes bytes as UTF-8 text, throwing {@link TextFileRejected} for binary or invalid content. */
export const decodeText: {
  (path: string): (bytes: Uint8Array) => ReturnType<typeof decodeTextBody>;
} & typeof decodeTextBody = EffectFunction.dual(2, decodeTextBody);
function decodeTextBody(bytes: Uint8Array, path: string): string {
  return Effect.runSync(decodeTextEffect({ bytes, path }));
}

export const decodeTextEffect = Effect.fnUntraced(function* (options: {
  readonly bytes: Uint8Array;
  readonly path: string;
}) {
  const { bytes, path } = options;
  if (bytes.includes(0)) return yield* TextFileRejected.make({ path, reason: { _tag: "binary" } });
  return yield* Effect.try({
    try: () => decoder.decode(bytes),
    catch: () => TextFileRejected.make({ path, reason: { _tag: "invalid_utf8" } }),
  });
});

/**
 * Reads a UTF-8 text file, rejecting linked leaves. POSIX uses atomic noFollow; Windows
 * checks the observed leaf before opening it. `path` is only used in errors.
 * Throws {@link TextFileRejected} for binary, oversized or undecodable content.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const readTextFile: {
  (path: string): (absolute: string) => ReturnType<typeof readTextFileBody>;
} & typeof readTextFileBody = EffectFunction.dual(2, readTextFileBody);
function readTextFileBody(absolute: string, path: string): Promise<TextFile> {
  return Effect.runPromise(readTextFileEffect({ absolute, path }));
}

export const readTextFileEffect = Effect.fn("readTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
}) {
  const { bytes, mode } = yield* readFileBytesEffect(options);
  const text = yield* decodeTextEffect({ bytes, path: options.path });
  return { text, sha256: sha256(bytes), bytes: bytes.length, mode };
});

/** Creates a new file, failing if anything already exists at that name. Parents are created. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const createTextFile: {
  (path: string, text: string): (absolute: string) => ReturnType<typeof createTextFileBody>;
} & typeof createTextFileBody = EffectFunction.dual(3, createTextFileBody);
function createTextFileBody(absolute: string, path: string, text: string) {
  return Effect.runPromise(createTextFileEffect({ absolute, path, text }));
}

export const createTextFileEffect = Effect.fn("createTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
  readonly text: string;
}) {
  const { absolute, path, text } = options;
  yield* fileIo(path, "mkdir", fileSystem.makeDirectory(dirname(absolute), { recursive: true }));
  const bytes = Buffer.from(text, "utf8");
  yield* Effect.acquireUseRelease(
    io(path, "open", () =>
      open(
        absolute,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      ),
    ).pipe(
      Effect.catchReason(
        "TextFileIoFailed",
        "IoFailed",
        (reason): Effect.Effect<never, TextFileIoFailed | TextFileRejected> =>
          isAlreadyExists(reason.cause)
            ? Effect.fail(TextFileRejected.make({ path, reason: { _tag: "exists" } }))
            : Effect.fail(TextFileIoFailed.make({ path, reason })),
      ),
    ),
    Effect.fnUntraced(function* (handle) {
      yield* io(path, "write", (signal) => handle.writeFile(bytes, { signal }));
      yield* io(path, "sync", () => handle.sync());
    }),
    (handle) => io(path, "close", () => handle.close()),
  );
  return { sha256: sha256(bytes), bytes: bytes.length };
});

/**
 * Replaces a file's content atomically (temp file in the same directory, then rename), but only
 * when it still has the content the caller read. The permission bits are kept.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const replaceTextFile: {
  (
    path: string,
    expectedSha256: string,
    text: string,
  ): (absolute: string) => ReturnType<typeof replaceTextFileBody>;
} & typeof replaceTextFileBody = EffectFunction.dual(4, replaceTextFileBody);
function replaceTextFileBody(absolute: string, path: string, expectedSha256: string, text: string) {
  return Effect.runPromise(replaceTextFileEffect({ absolute, path, expectedSha256, text }));
}

export const replaceTextFileEffect = Effect.fn("replaceTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly text: string;
}) {
  const { absolute, path, expectedSha256, text } = options;
  const current = yield* readTextFileEffect({ absolute, path });
  if (current.sha256 !== expectedSha256)
    return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
  const bytes = Buffer.from(text, "utf8");
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${yield* hostCrypto.randomUUIDv4()}.tmp`,
  );
  yield* Effect.acquireUseRelease(
    io(path, "open", () =>
      open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        current.mode,
      ),
    ),
    Effect.fnUntraced(function* (handle) {
      yield* io(path, "write", (signal) => handle.writeFile(bytes, { signal }));
      yield* io(path, "sync", () => handle.sync());
      yield* io(path, "close", () => handle.close());
      const latest = yield* readTextFileEffect({ absolute, path });
      if (latest.sha256 !== expectedSha256)
        return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
      // A committed swap must complete before interruption releases its temporary file.
      yield* Effect.uninterruptible(fileIo(path, "rename", fileSystem.rename(temporary, absolute)));
    }),
    Effect.fnUntraced(function* (handle) {
      const closed = yield* Effect.exit(io(path, "close", () => handle.close()));
      const removed = yield* Effect.exit(
        fileIo(path, "remove", fileSystem.remove(temporary, { force: true })),
      );
      yield* closed;
      yield* removed;
    }),
  );
  return { sha256: sha256(bytes), bytes: bytes.length };
});

/** Removes a file only when it still has the content the caller read. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const deleteTextFile: {
  (
    path: string,
    expectedSha256: string,
  ): (absolute: string) => ReturnType<typeof deleteTextFileBody>;
} & typeof deleteTextFileBody = EffectFunction.dual(3, deleteTextFileBody);
function deleteTextFileBody(absolute: string, path: string, expectedSha256: string) {
  return Effect.runPromise(deleteTextFileEffect({ absolute, path, expectedSha256 }));
}

export const deleteTextFileEffect = Effect.fn("deleteTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
  readonly expectedSha256: string;
}) {
  const { absolute, path, expectedSha256 } = options;
  const current = yield* readTextFileEffect({ absolute, path });
  if (current.sha256 !== expectedSha256)
    return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
  yield* fileIo(path, "remove", fileSystem.remove(absolute));
  return { bytes: current.bytes };
});

export interface LinePage {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  /** First line of the next page, or null when this page reaches the end. */
  readonly nextStartLine: number | null;
  /** True when a single line was longer than the page and only its start is shown. */
  readonly lineTruncated: boolean;
}

/** Characters of file content returned per read page. */
export const readPageCharacters = 16_000;

/**
 * One page of a text file by 1-based line numbers. Line endings are kept exactly, so CRLF files
 * can be edited with the text as read.
 */
export const linePage: {
  (startLine: number, maxLines: number): (text: string) => ReturnType<typeof linePageBody>;
} & typeof linePageBody = EffectFunction.dual(3, linePageBody);
function linePageBody(text: string, startLine: number, maxLines: number): LinePage {
  return linePageOf(splitLines(text), startLine, maxLines);
}

/** Lines with their endings kept, so joining them gives the text back. */
export const splitLines = (text: string): readonly string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** {@link linePage} over lines already split with {@link splitLines}. */
export const linePageOf: {
  (
    startLine: number,
    maxLines: number,
  ): (lines: readonly string[]) => ReturnType<typeof linePageOfBody>;
} & typeof linePageOfBody = EffectFunction.dual(3, linePageOfBody);
function linePageOfBody(lines: readonly string[], startLine: number, maxLines: number): LinePage {
  const totalLines = lines.length;
  const first = Math.max(1, Math.min(startLine, totalLines + 1));
  let content = "";
  let line = first;
  while (line <= totalLines && line - first < maxLines) {
    const next = lines[line - 1]!;
    if (content.length + next.length > readPageCharacters) break;
    content += next;
    line++;
  }
  if (line === first && line <= totalLines) {
    // One line alone is bigger than a page (minified code): show its start, never split a pair.
    let end = readPageCharacters;
    const code = lines[line - 1]!.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    return {
      content: lines[line - 1]!.slice(0, end),
      startLine: first,
      endLine: first,
      totalLines,
      nextStartLine: first < totalLines ? first + 1 : null,
      lineTruncated: true,
    };
  }
  return {
    content,
    startLine: first,
    endLine: line - 1,
    totalLines,
    nextStartLine: line <= totalLines ? line : null,
    lineTruncated: false,
  };
}

interface LineIndex {
  readonly stamp: string;
  readonly sha256: string;
  readonly offsets: Uint32Array;
  readonly size: number;
}

/** Only offsets and a digest survive a call; handles and decoded text belong to that call's Scope. */
export const createTextPageReader = () => {
  const cache = MutableHashMap.empty<string, LineIndex>();
  return Effect.fn("readTextPage")(function* (options: {
    readonly absolute: string;
    readonly path: string;
    readonly startLine: number;
    readonly maxLines: number;
    readonly checkLeaf?: boolean;
  }) {
    const { absolute, path, startLine, maxLines, checkLeaf = false } = options;
    return yield* Effect.acquireUseRelease(
      io(path, "open", () => open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)),
      Effect.fnUntraced(function* (handle) {
        const stats = yield* io(path, "stat", () => handle.stat({ bigint: true }));
        if (!stats.isFile()) return yield* new PathRejected({ path, reason: "not_file" });
        if (checkLeaf && stats.nlink !== 1n)
          return yield* new PathRejected({ path, reason: "hard_link" });
        if (stats.size > BigInt(maxTextBytes))
          return yield* TextFileRejected.make({ path, reason: { _tag: "too_large" } });
        const stampOf = (stat: typeof stats) =>
          `${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeNs}:${stat.mtimeNs}`;
        const stamp = stampOf(stats);
        let index = Option.getOrUndefined(MutableHashMap.get(cache, absolute));
        if (index?.stamp !== stamp) {
          const size = Number(stats.size);
          const offsets: number[] = size === 0 ? [] : [0];
          const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
          // At most maxTextBytes: the whole content stays in memory for one Crypto.digest.
          const contents = Buffer.alloc(size);
          let position = 0;
          while (position < size) {
            // Positional reads cannot be aborted by Node: await each native read before Scope closes.
            const read = yield* Effect.uninterruptible(
              io(path, "read", () =>
                handle.read(contents, position, Math.min(64 * 1024, size - position), position),
              ),
            );
            if (read.bytesRead === 0)
              return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
            const bytes = contents.subarray(position, position + read.bytesRead);
            if (bytes.includes(0))
              return yield* TextFileRejected.make({ path, reason: { _tag: "binary" } });
            yield* Effect.try({
              try: () => utf8.decode(bytes, { stream: true }),
              catch: () => TextFileRejected.make({ path, reason: { _tag: "invalid_utf8" } }),
            });
            for (let i = 0; i < bytes.length; i++)
              if (bytes[i] === 10 && position + i + 1 < size) offsets.push(position + i + 1);
            position += read.bytesRead;
            yield* Effect.yieldNow;
          }
          yield* Effect.try({
            try: () => utf8.decode(),
            catch: () => TextFileRejected.make({ path, reason: { _tag: "invalid_utf8" } }),
          });
          // NodeCrypto digest only fails as a defect, as createHash did.
          const digest = yield* Effect.orDie(hostCrypto.digest("SHA-256", contents));
          index = { stamp, size, offsets: Uint32Array.from(offsets), sha256: Hex.encode(digest) };
        }
        const totalLines = index.offsets.length;
        const first = Math.max(1, Math.min(startLine, totalLines + 1));
        const begin = index.offsets[first - 1] ?? index.size;
        const end = index.offsets[Math.min(first - 1 + maxLines, totalLines)] ?? index.size;
        // Enough bytes for the UTF-16 page budget, plus an incomplete UTF-8 boundary.
        const buffer = Buffer.alloc(Math.min(end - begin, readPageCharacters * 4 + 4));
        let consumed = 0;
        while (consumed < buffer.length) {
          const read = yield* Effect.uninterruptible(
            io(path, "read", () =>
              handle.read(buffer, consumed, buffer.length - consumed, begin + consumed),
            ),
          );
          if (read.bytesRead === 0)
            return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
          consumed += read.bytesRead;
        }
        const text = yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer, {
              stream: begin + buffer.length < end,
            }),
          catch: () => TextFileRejected.make({ path, reason: { _tag: "invalid_utf8" } }),
        });
        const latest = yield* io(path, "stat", () => handle.stat({ bigint: true }));
        if (stampOf(latest) !== stamp)
          return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
        MutableHashMap.remove(cache, absolute);
        MutableHashMap.set(cache, absolute, index);
        for (const old of MutableHashMap.keys(cache)) {
          if (MutableHashMap.size(cache) <= 8) break;
          MutableHashMap.remove(cache, old);
        }
        const page = linePage(text, 1, maxLines);
        const endLine = first + page.endLine - 1;
        return {
          sha256: index.sha256,
          content: page.content,
          startLine: first,
          endLine,
          totalLines,
          nextStartLine: endLine < totalLines ? endLine + 1 : null,
          lineTruncated: page.lineTruncated,
        };
      }),
      (handle) => io(path, "close", () => handle.close()),
    );
  });
};
