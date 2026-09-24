import { Option, Schema } from "effect";
import { PathRejected } from "./paths.ts";
import { decodeText, TextFileRejected } from "./text.ts";

export interface SearchMatch {
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** The line, shortened around the match when long. */
  readonly text: string;
}

export interface SearchSkip {
  readonly path: string;
  readonly reason: string;
}

/** Where a search stopped: the file index in the snapshot and the 0-based line inside it. */
export interface SearchPosition {
  readonly file: number;
  readonly line: number;
}

export interface SearchPage {
  readonly matches: readonly SearchMatch[];
  readonly skipped: readonly SearchSkip[];
  readonly next: SearchPosition | null;
}

const matchLimit = 100;
const pageCharacters = 12_000;
/** Files opened per page, so a search over a huge tree still answers in bounded time. */
const filesPerPage = 2_000;
const snippetCharacters = 300;
/** Files read ahead at once; results are still taken in order. */
const readAhead = 32;

function snippet(line: string, index: number) {
  if (line.length <= snippetCharacters) return line;
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, start + snippetCharacters)}…`;
}

type FileRead =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "gone" };

export interface SearchOptions {
  /**
   * Files known to contain the query (from `git grep`); other files are not opened. Null searches
   * every file.
   */
  readonly candidates?: ReadonlySet<string> | null;
}

/** Matches of `needle` in `text`, one per line, from 0-based line `fromLine`. */
function* lineMatches(text: string, needle: string, caseSensitive: boolean, fromLine: number) {
  const haystack = caseSensitive ? text : text.toLowerCase();
  if (haystack.length !== text.length) {
    // Lowercasing changed the length (rare letters), so positions would not line up: go by line.
    const lines = text.split("\n");
    for (let line = fromLine; line < lines.length; line++) {
      const content = lines[line]!.replace(/\r$/, "");
      const column = content.toLowerCase().indexOf(needle);
      if (column >= 0) yield { line, content, column };
    }
    return;
  }
  let line = 0;
  let lineStart = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    // Advance the line counter to the match.
    let newline = text.indexOf("\n", lineStart);
    while (newline >= 0 && newline < index) {
      line++;
      lineStart = newline + 1;
      newline = text.indexOf("\n", lineStart);
    }
    const lineEnd = newline < 0 ? text.length : newline;
    if (line >= fromLine) {
      const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
      yield { line, content, column: index - lineStart };
    }
    if (newline < 0) return;
    // One match per line: continue on the next line.
    line++;
    lineStart = newline + 1;
    index = haystack.indexOf(needle, lineStart);
  }
}

/**
 * One page of a literal line search over a fixed list of files, starting at `start`. `readBytes`
 * resolves and reads one file; its {@link PathRejected} or {@link TextFileRejected} failures are
 * reported as skipped (a file that vanished is dropped silently).
 *
 * A file whose bytes do not contain a case-sensitive query cannot match, so it is not decoded, and
 * a binary or non-UTF-8 file is only reported as skipped when it might have matched.
 */
export async function searchTextFiles(
  paths: readonly string[],
  readBytes: (path: string) => Promise<Uint8Array>,
  query: string,
  caseSensitive: boolean,
  start: SearchPosition,
  options: SearchOptions = {},
): Promise<SearchPage> {
  const needle = caseSensitive ? query : query.toLowerCase();
  const needleBytes = Buffer.from(query, "utf8");
  const candidates = options.candidates ?? null;
  const matches: SearchMatch[] = [];
  const skipped: SearchSkip[] = [];
  let characters = 0;
  let opened = 0;

  const reads = new Map<number, Promise<FileRead>>();
  const read = (file: number) => {
    const existing = reads.get(file);
    if (existing) return existing;
    const path = paths[file]!;
    const pending = readBytes(path).then(
      (bytes): FileRead => ({ kind: "bytes", bytes }),
      (error): FileRead => {
        const reason =
          error instanceof PathRejected || error instanceof TextFileRejected
            ? error.reason
            : "unreadable";
        return reason === "not_found" ? { kind: "gone" } : { kind: "skipped", reason };
      },
    );
    reads.set(file, pending);
    return pending;
  };
  // The files this page may open, in order: every file, or only the candidates.
  const order: number[] = [];
  for (let file = start.file; file < paths.length; file++)
    if (candidates === null || candidates.has(paths[file]!)) order.push(file);

  for (let position = 0; position < order.length; position++) {
    const file = order[position]!;
    if (opened === filesPerPage) return { matches, skipped, next: { file, line: 0 } };
    opened++;
    // Start the next few reads now, so the disk works while this file is matched.
    for (const ahead of order.slice(position + 1, position + 1 + readAhead)) void read(ahead);
    const path = paths[file]!;
    const result = await read(file);
    reads.delete(file);
    switch (result.kind) {
      case "gone":
        continue;
      case "skipped":
        skipped.push({ path, reason: result.reason });
        continue;
      case "bytes":
        break;
    }
    if (caseSensitive && Buffer.from(result.bytes).indexOf(needleBytes) < 0) continue;
    let text: string;
    try {
      text = decodeText(result.bytes, path);
    } catch (error) {
      skipped.push({
        path,
        reason: error instanceof TextFileRejected ? error.reason : "unreadable",
      });
      continue;
    }
    const fromLine = file === start.file ? start.line : 0;
    for (const found of lineMatches(text, needle, caseSensitive, fromLine)) {
      const match = { path, line: found.line + 1, text: snippet(found.content, found.column) };
      matches.push(match);
      characters += match.path.length + match.text.length + 32;
      if (matches.length < matchLimit && characters < pageCharacters) continue;
      // Lines are counted as split on "\n": one more than the newlines.
      const totalLines = text.split("\n").length;
      const next =
        found.line + 1 < totalLines ? { file, line: found.line + 1 } : { file: file + 1, line: 0 };
      return { matches, skipped, next: next.file < paths.length ? next : null };
    }
  }
  return { matches, skipped, next: null };
}

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.String,
    query: Schema.String,
    caseSensitive: Schema.Boolean,
    file: Schema.Int,
    line: Schema.Int,
  }),
);
export type SearchCursor = typeof Cursor.Type;

/** An opaque continuation token for the model. */
export const encodeSearchCursor = (cursor: SearchCursor) =>
  Buffer.from(Schema.encodeSync(Cursor)(cursor)).toString("base64url");

export const decodeSearchCursor = (text: string) =>
  Option.getOrUndefined(
    Schema.decodeOption(Cursor)(Buffer.from(text, "base64url").toString("utf8")),
  );
