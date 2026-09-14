import { Option, Schema } from "effect";
import { PathRejected } from "./paths.ts";
import { TextFileRejected } from "./text.ts";

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

function snippet(line: string, index: number) {
  if (line.length <= snippetCharacters) return line;
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, start + snippetCharacters)}…`;
}

/**
 * One page of a literal line search over a fixed list of files, starting at `start`. `openText`
 * resolves and reads one file; its {@link PathRejected} or {@link TextFileRejected} failures are
 * reported as skipped (a file that vanished is dropped silently).
 */
export async function searchTextFiles(
  paths: readonly string[],
  openText: (path: string) => Promise<string>,
  query: string,
  caseSensitive: boolean,
  start: SearchPosition,
): Promise<SearchPage> {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  const skipped: SearchSkip[] = [];
  let characters = 0;
  let opened = 0;

  for (let file = start.file; file < paths.length; file++) {
    if (opened === filesPerPage) return { matches, skipped, next: { file, line: 0 } };
    opened++;
    const path = paths[file]!;
    let text: string;
    try {
      text = await openText(path);
    } catch (error) {
      const reason =
        error instanceof PathRejected || error instanceof TextFileRejected
          ? error.reason
          : "unreadable";
      if (reason !== "not_found") skipped.push({ path, reason });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let line = file === start.file ? start.line : 0; line < lines.length; line++) {
      const content = lines[line]!;
      const index = (caseSensitive ? content : content.toLowerCase()).indexOf(needle);
      if (index < 0) continue;
      const match = { path, line: line + 1, text: snippet(content, index) };
      matches.push(match);
      characters += match.path.length + match.text.length + 32;
      if (matches.length < matchLimit && characters < pageCharacters) continue;
      const next = line + 1 < lines.length ? { file, line: line + 1 } : { file: file + 1, line: 0 };
      return { matches, skipped, next: next.file < paths.length ? next : null };
    }
  }
  return { matches, skipped, next: null };
}

const Cursor = Schema.parseJson(
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
    Schema.decodeUnknownOption(Cursor)(Buffer.from(text, "base64url").toString("utf8")),
  );
