import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Data, Schema } from "effect";
import { PathRejected } from "./paths.ts";

/** Largest text file the file tools read, search or rewrite. */
export const maxTextBytes = 2 * 1024 * 1024;

/**
 * A file that is not editable text: over {@link maxTextBytes}, containing NUL bytes, or not UTF-8.
 * `changed` means its content no longer matches the version the caller last read.
 */
export class TextFileRejected extends Data.TaggedError("TextFileRejected")<{
  readonly path: string;
  readonly reason: "too_large" | "binary" | "invalid_utf8" | "changed" | "exists";
}> {}

export interface TextFile {
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Permission bits, kept when the file is rewritten. */
  readonly mode: number;
}

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isAlreadyExists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));

/** A file's raw bytes, read without following a symlink at the leaf and at most {@link maxTextBytes}. */
export interface FileBytes {
  readonly bytes: Buffer;
  readonly mode: number;
}

/**
 * Reads raw bytes (no text checks). Throws {@link TextFileRejected} `too_large`. With `checkLeaf`,
 * the opened file itself must be a regular file with one link, checked on the handle (for callers
 * that validated the directories but not the file).
 */
export async function readFileBytes(
  absolute: string,
  path: string,
  checkLeaf = false,
): Promise<FileBytes> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (checkLeaf && !stats.isFile()) throw new PathRejected({ path, reason: "not_file" });
    if (checkLeaf && stats.nlink !== 1) throw new PathRejected({ path, reason: "hard_link" });
    if (stats.size > maxTextBytes) throw new TextFileRejected({ path, reason: "too_large" });
    const bytes = await handle.readFile();
    if (bytes.length > maxTextBytes) throw new TextFileRejected({ path, reason: "too_large" });
    return { bytes, mode: stats.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

/** Decodes bytes as UTF-8 text, throwing {@link TextFileRejected} for binary or invalid content. */
export function decodeText(bytes: Uint8Array, path: string): string {
  if (bytes.includes(0)) throw new TextFileRejected({ path, reason: "binary" });
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TextFileRejected({ path, reason: "invalid_utf8" });
  }
}

/**
 * Reads a UTF-8 text file without following a symlink at the leaf. `path` is only used in errors.
 * Throws {@link TextFileRejected} for binary, oversized or undecodable content.
 */
export async function readTextFile(absolute: string, path: string): Promise<TextFile> {
  const { bytes, mode } = await readFileBytes(absolute, path);
  const text = decodeText(bytes, path);
  return { text, sha256: sha256(bytes), bytes: bytes.length, mode };
}

/** Creates a new file, failing if anything already exists at that name. Parents are created. */
export async function createTextFile(absolute: string, path: string, text: string) {
  await mkdir(dirname(absolute), { recursive: true });
  const bytes = Buffer.from(text, "utf8");
  let handle;
  try {
    handle = await open(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    if (isAlreadyExists(error)) throw new TextFileRejected({ path, reason: "exists" });
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * Replaces a file's content atomically (temp file in the same directory, then rename), but only
 * when it still has the content the caller read. The permission bits are kept.
 */
export async function replaceTextFile(
  absolute: string,
  path: string,
  expectedSha256: string,
  text: string,
) {
  const current = await readTextFile(absolute, path);
  if (current.sha256 !== expectedSha256) throw new TextFileRejected({ path, reason: "changed" });
  const bytes = Buffer.from(text, "utf8");
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    current.mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    // Re-check right before the swap: a user edit made while we wrote must not be overwritten.
    const latest = await readTextFile(absolute, path);
    if (latest.sha256 !== expectedSha256) throw new TextFileRejected({ path, reason: "changed" });
    await rename(temporary, absolute);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  return { sha256: sha256(bytes), bytes: bytes.length };
}

/** Removes a file only when it still has the content the caller read. */
export async function deleteTextFile(absolute: string, path: string, expectedSha256: string) {
  const current = await readTextFile(absolute, path);
  if (current.sha256 !== expectedSha256) throw new TextFileRejected({ path, reason: "changed" });
  await rm(absolute);
  return { bytes: current.bytes };
}

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
export function linePage(text: string, startLine: number, maxLines: number): LinePage {
  return linePageOf(splitLines(text), startLine, maxLines);
}

/** Lines with their endings kept, so joining them gives the text back. */
export const splitLines = (text: string): readonly string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** {@link linePage} over lines already split with {@link splitLines}. */
export function linePageOf(
  lines: readonly string[],
  startLine: number,
  maxLines: number,
): LinePage {
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
