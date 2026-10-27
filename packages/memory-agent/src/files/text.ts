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
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Exit, Match, MutableHashMap, Option, Schema, Scope } from "effect";
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

/** Why a file is not editable text; see {@link TextFileRejected}. */
export const TextFileRejectedReason = Schema.TaggedUnion({
  too_large: {},
  binary: {},
  invalid_utf8: {},
  changed: {},
  exists: {},
});
const rejection = TextFileRejectedReason.cases;

/** The reason's name, for a skip label or a log. */
export const textFileRejectedReasonName = (reason: TextFileRejected["reason"]): string =>
  TextFileRejectedReason.match(reason, {
    too_large: () => "too_large",
    binary: () => "binary",
    invalid_utf8: () => "invalid_utf8",
    changed: () => "changed",
    exists: () => "exists",
  });

/**
 * A file that is not editable text: over {@link maxTextBytes}, containing NUL bytes, or not UTF-8.
 * `changed` means its content no longer matches the version the caller last read.
 */
export class TextFileRejected extends Schema.TaggedError<TextFileRejected>()("TextFileRejected", {
  path: Schema.String,
  reason: TextFileRejectedReason,
}) {}

/** The file no longer has the content the caller read. */
const changed = (path: string) =>
  Effect.fail(TextFileRejected.make({ path, reason: rejection.changed.make({}) }));

/** The file operation that failed and its system code; see {@link TextFileIoFailed}. */
export const TextFileIoReason = Schema.TaggedStruct("IoFailed", {
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
});

export class TextFileIoFailed extends Schema.TaggedError<TextFileIoFailed>()("TextFileIoFailed", {
  path: Schema.String,
  reason: TextFileIoReason,
}) {}

const systemCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

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
        reason: TextFileIoReason.make({
          operation,
          code: Option.getOrUndefined(systemCode(cause))?.code ?? "unknown",
          cause,
        }),
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

/** A file's raw bytes, with a rejected linked leaf and at most {@link maxTextBytes}. */
export interface FileBytes {
  readonly bytes: Buffer;
  readonly mode: number;
}

interface FileReadOptions {
  readonly absolute: string;
  readonly path: string;
  readonly checkLeaf?: boolean;
}

/** Reads an opened file whole, at most {@link maxTextBytes}, with positional reads. */
const readOpenedFile = Effect.fnUntraced(function* (
  handle: FileSystem.File,
  options: FileReadOptions,
) {
  const { path, checkLeaf = false } = options;
  const stats = yield* fileIo(path, "stat", handle.stat);
  if (checkLeaf && stats.type !== "File")
    return yield* PathRejected.make({ path, reason: "not_file" });
  if (checkLeaf && Option.getOrUndefined(stats.nlink) !== 1)
    return yield* PathRejected.make({ path, reason: "hard_link" });
  if (stats.size > BigInt(maxTextBytes))
    return yield* TextFileRejected.make({ path, reason: rejection.too_large.make({}) });
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
      return yield* TextFileRejected.make({ path, reason: rejection.too_large.make({}) });
    chunks.push(buffer.subarray(0, read));
    yield* Effect.yieldNow;
  }
  return { bytes: Buffer.concat(chunks, size), mode: stats.mode & 0o7777 };
});

// Windows has no O_NOFOLLOW. lstat rejects an observed linked leaf; this does not provide POSIX's
// atomic no-follow guarantee.
const readWindowsFileBytes = Effect.fn("readWindowsFileBytes")(function* (
  options: FileReadOptions,
) {
  const { absolute, path } = options;
  const leaf = yield* fileIo(path, "open", fileSystem.lstat(absolute));
  if (leaf.type === "SymbolicLink") return yield* PathRejected.make({ path, reason: "symlink" });
  return yield* Effect.scoped(
    fileIo(path, "open", fileSystem.open(absolute)).pipe(
      Effect.flatMap((handle) => readOpenedFile(handle, options)),
    ),
  );
});

const readPosixFileBytes = Effect.fn("readPosixFileBytes")(function* (options: FileReadOptions) {
  const { absolute, path } = options;
  return yield* Effect.scoped(
    fileIo(path, "open", fileSystem.open(absolute, { noFollow: true })).pipe(
      Effect.flatMap((handle) => readOpenedFile(handle, options)),
    ),
  );
});

/**
 * Reads raw bytes (no text checks). Fails with {@link TextFileRejected} `too_large`. With
 * `checkLeaf`, the opened file itself must be a regular file with one link, checked on the handle
 * (for callers that validated the directories but not the file).
 */
export const readFileBytesEffect = Effect.fn("readFileBytes")(function* (options: FileReadOptions) {
  return yield* Match.value(yield* FileReadPlatform).pipe(
    Match.when("windows", () => readWindowsFileBytes(options)),
    Match.when("posix", () => readPosixFileBytes(options)),
    Match.exhaustive,
  );
});

/** Decodes bytes as UTF-8 text, failing with {@link TextFileRejected} for binary or invalid content. */
export const decodeTextEffect = Effect.fnUntraced(function* (options: {
  readonly bytes: Uint8Array;
  readonly path: string;
}) {
  const { bytes, path } = options;
  yield* Effect.when(
    Effect.fail(TextFileRejected.make({ path, reason: rejection.binary.make({}) })),
    Effect.succeed(bytes.includes(0)),
  );
  return yield* Effect.try({
    try: () => decoder.decode(bytes),
    catch: () => TextFileRejected.make({ path, reason: rejection.invalid_utf8.make({}) }),
  });
});

/**
 * Reads a UTF-8 text file, rejecting linked leaves. POSIX uses atomic noFollow; Windows
 * checks the observed leaf before opening it. `path` is only used in errors.
 * Fails with {@link TextFileRejected} for binary, oversized or undecodable content.
 */
export const readTextFileEffect = Effect.fn("readTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
}) {
  const { bytes, mode } = yield* readFileBytesEffect(options);
  const text = yield* decodeTextEffect({ bytes, path: options.path });
  return { text, sha256: sha256(bytes), bytes: bytes.length, mode };
});

/** Creates a new file, failing if anything already exists at that name. Parents are created. */
export const createTextFileEffect = Effect.fn("createTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
  readonly text: string;
}) {
  const { absolute, path, text } = options;
  yield* fileIo(path, "mkdir", fileSystem.makeDirectory(dirname(absolute), { recursive: true }));
  const bytes = Buffer.from(text, "utf8");
  const noFollow = (yield* FileReadPlatform) === "posix";
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(absolute, { flag: "wx", mode: 0o644, noFollow }).pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () =>
          Effect.fail(TextFileRejected.make({ path, reason: rejection.exists.make({}) })),
        ),
        Effect.catchTag("PlatformError", (error) => fileIo(path, "open", Effect.fail(error))),
      );
      yield* fileIo(path, "write", handle.writeAll(bytes));
      yield* fileIo(path, "sync", handle.sync);
    }),
  );
  return { sha256: sha256(bytes), bytes: bytes.length };
});

/**
 * Replaces a file's content atomically (temp file in the same directory, then rename), but only
 * when it still has the content the caller read. The permission bits are kept.
 */
export const replaceTextFileEffect = Effect.fn("replaceTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly text: string;
}) {
  const { absolute, path, expectedSha256, text } = options;
  const current = yield* readTextFileEffect({ absolute, path });
  yield* Effect.when(changed(path), Effect.succeed(current.sha256 !== expectedSha256));
  const bytes = Buffer.from(text, "utf8");
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${yield* hostCrypto.randomUUIDv4()}.tmp`,
  );
  const noFollow = (yield* FileReadPlatform) === "posix";
  // The temporary file's handle lives in its own scope, so it closes before the swap and the
  // release still removes the file whether writing, the check or the swap failed.
  yield* Effect.acquireUseRelease(
    Scope.make(),
    Effect.fnUntraced(function* (scope) {
      yield* Effect.gen(function* () {
        const handle = yield* fileIo(
          path,
          "open",
          fileSystem.open(temporary, { flag: "wx", mode: current.mode, noFollow }),
        );
        yield* fileIo(path, "write", handle.writeAll(bytes));
        yield* fileIo(path, "sync", handle.sync);
      }).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      const latest = yield* readTextFileEffect({ absolute, path });
      yield* Effect.when(changed(path), Effect.succeed(latest.sha256 !== expectedSha256));
      // A committed swap must complete before interruption releases its temporary file.
      yield* Effect.uninterruptible(fileIo(path, "rename", fileSystem.rename(temporary, absolute)));
    }),
    (scope, exit) =>
      Scope.close(scope, exit).pipe(
        Effect.andThen(fileIo(path, "remove", fileSystem.remove(temporary, { force: true }))),
      ),
  );
  return { sha256: sha256(bytes), bytes: bytes.length };
});

/** Removes a file only when it still has the content the caller read. */
export const deleteTextFileEffect = Effect.fn("deleteTextFile")(function* (options: {
  readonly absolute: string;
  readonly path: string;
  readonly expectedSha256: string;
}) {
  const { absolute, path, expectedSha256 } = options;
  const current = yield* readTextFileEffect({ absolute, path });
  yield* Effect.when(changed(path), Effect.succeed(current.sha256 !== expectedSha256));
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
    const noFollow = (yield* FileReadPlatform) === "posix";
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileIo(path, "open", fileSystem.open(absolute, { noFollow }));
        const stats = yield* fileIo(path, "stat", handle.stat);
        if (stats.type !== "File") return yield* PathRejected.make({ path, reason: "not_file" });
        if (checkLeaf && Option.getOrUndefined(stats.nlink) !== 1)
          return yield* PathRejected.make({ path, reason: "hard_link" });
        if (stats.size > BigInt(maxTextBytes))
          return yield* TextFileRejected.make({ path, reason: rejection.too_large.make({}) });
        const stampOf = (stat: FileSystem.File.Info) =>
          `${stat.dev}:${Option.getOrNull(stat.ino)}:${stat.size}:${Option.getOrNull(stat.ctimeNs)}:${Option.getOrNull(stat.mtimeNs)}`;
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
              fileIo(
                path,
                "read",
                handle.read(contents.subarray(position, Math.min(position + 64 * 1024, size)), {
                  position: BigInt(position),
                }),
              ),
            );
            if (read === 0)
              return yield* TextFileRejected.make({ path, reason: rejection.changed.make({}) });
            const bytes = contents.subarray(position, position + read);
            if (bytes.includes(0))
              return yield* TextFileRejected.make({ path, reason: rejection.binary.make({}) });
            yield* Effect.try({
              try: () => utf8.decode(bytes, { stream: true }),
              catch: () => TextFileRejected.make({ path, reason: rejection.invalid_utf8.make({}) }),
            });
            for (let i = 0; i < bytes.length; i++)
              if (bytes[i] === 10 && position + i + 1 < size) offsets.push(position + i + 1);
            position += read;
            yield* Effect.yieldNow;
          }
          yield* Effect.try({
            try: () => utf8.decode(),
            catch: () => TextFileRejected.make({ path, reason: rejection.invalid_utf8.make({}) }),
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
            fileIo(
              path,
              "read",
              handle.read(buffer.subarray(consumed), { position: BigInt(begin + consumed) }),
            ),
          );
          if (read === 0)
            return yield* TextFileRejected.make({ path, reason: rejection.changed.make({}) });
          consumed += read;
        }
        const text = yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer, {
              stream: begin + buffer.length < end,
            }),
          catch: () => TextFileRejected.make({ path, reason: rejection.invalid_utf8.make({}) }),
        });
        const latest = yield* fileIo(path, "stat", handle.stat);
        yield* Effect.when(changed(path), Effect.succeed(stampOf(latest) !== stamp));
        MutableHashMap.remove(cache, absolute);
        MutableHashMap.set(cache, absolute, index);
        // Keys come out oldest first; the file just indexed is the newest.
        Array.from(MutableHashMap.keys(cache))
          .slice(0, Math.max(0, MutableHashMap.size(cache) - 8))
          .forEach((old) => MutableHashMap.remove(cache, old));
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
    );
  });
};
