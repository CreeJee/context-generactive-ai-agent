import { Result, Function as EffectFunction } from "effect";
import { Array as Arr, Data, Effect, HashSet, Option, Predicate, Schema, Stream } from "effect";
import { PathRejected } from "./paths.ts";
import {
  decodeTextEffect,
  type LinePage,
  TextFileIoFailed,
  TextFileRejected,
  textFileRejectedReasonName,
} from "./text.ts";

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
const readAhead = 4;

function snippet(line: string, index: number) {
  if (line.length <= snippetCharacters) return line;
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, start + snippetCharacters)}…`;
}

type FileRead = Data.TaggedEnum<{
  bytes: { readonly bytes: Uint8Array };
  skipped: { readonly reason: string };
  gone: {};
}>;
const FileRead = Data.taggedEnum<FileRead>();

export interface SearchOptions {
  /**
   * Files known to contain the query (from `git grep`); other files are not opened. Null searches
   * every file.
   */
  readonly candidates?: HashSet.HashSet<string> | null;
}

/** A line holding a match: its 0-based number, its text without the ending, and the match's column. */
interface LineMatch {
  readonly line: number;
  readonly content: string;
  readonly column: number;
}

/** The first index from `low` up to `high` whose value in ascending `sorted` is at least `value`. */
const lowerBound = (
  sorted: ReadonlyArray<number>,
  value: number,
  low: number,
  high: number,
): number => {
  if (low >= high) return low;
  const middle = (low + high) >>> 1;
  return (sorted[middle] ?? value) < value
    ? lowerBound(sorted, value, middle + 1, high)
    : lowerBound(sorted, value, low, middle);
};

/** Up to `limit` matches of `needle` in `text`, one per line, from 0-based line `fromLine`. */
const lineMatches = (
  text: string,
  needle: string,
  caseSensitive: boolean,
  fromLine: number,
  limit: number,
): ReadonlyArray<LineMatch> => {
  const haystack = caseSensitive ? text : text.toLowerCase();
  // Lowercasing changed the length (rare letters), so positions would not line up: go by line.
  const byLine = () =>
    text
      .split("\n")
      .slice(fromLine)
      .flatMap((line, offset) => {
        const content = line.replace(/\r$/, "");
        const column = content.toLowerCase().indexOf(needle);
        return column >= 0 ? [{ line: fromLine + offset, content, column }] : [];
      })
      .slice(0, limit);
  const byPosition = () => {
    // Each line ends at the newline after it; the last ends with the text.
    const newlines = Arr.unfold(text.indexOf("\n"), (at) =>
      at < 0 ? Option.none() : Option.some([at, text.indexOf("\n", at + 1)] as const),
    );
    const lineStart = (line: number) => (newlines[line - 1] ?? -1) + 1;
    // One match per line: each search continues on the line after the last match.
    return Arr.unfold({ line: fromLine, left: limit }, ({ line, left }) =>
      Option.some(line).pipe(
        Option.filter(() => left > 0 && line <= newlines.length),
        Option.map(() => haystack.indexOf(needle, lineStart(line))),
        Option.filter((index) => index >= 0),
        Option.map((index) => {
          const found = lowerBound(newlines, index, line, newlines.length);
          const start = lineStart(found);
          const content = text.slice(start, newlines[found] ?? text.length).replace(/\r$/, "");
          return [
            { line: found, content, column: index - start },
            { line: found + 1, left: left - 1 },
          ] as const;
        }),
      ),
    );
  };
  return haystack.length !== text.length ? byLine() : byPosition();
};

/** A page being filled: what it holds and, once full, where the next one starts (null at the end). */
interface Search {
  readonly matches: ReadonlyArray<SearchMatch>;
  readonly skipped: ReadonlyArray<SearchSkip>;
  readonly characters: number;
  readonly next: Option.Option<SearchPosition | null>;
}

const emptySearch: Search = { matches: [], skipped: [], characters: 0, next: Option.none() };

/** Adds `found` up to the match that fills the page, and returns that match when one does. */
const collect = (search: Search, found: ReadonlyArray<SearchMatch>) => {
  const sizes = Arr.scan(
    found,
    search.characters,
    (characters, match) => characters + match.path.length + match.text.length + 32,
  ).slice(1);
  const filling = Arr.findFirstIndex(
    sizes,
    (characters, index) =>
      search.matches.length + index + 1 >= matchLimit || characters >= pageCharacters,
  );
  const taken = Option.match(filling, {
    onNone: () => found.length,
    onSome: (index) => index + 1,
  });
  return {
    search: {
      ...search,
      matches: [...search.matches, ...found.slice(0, taken)],
      characters: sizes[taken - 1] ?? search.characters,
    },
    filledBy: Option.flatMap(filling, (index) => Arr.get(found, index)),
  };
};

/** The files a page may open, in order from `start`: every file, or only the candidates. */
const searchOrder = (
  paths: readonly string[],
  start: SearchPosition,
  candidates: HashSet.HashSet<string> | null | undefined,
) =>
  paths
    .map((path, file) => ({ path, file }))
    .slice(start.file)
    .filter(({ path }) => candidates == null || HashSet.has(candidates, path));

/** The page a search ends with: where it filled, else the first file it did not open, else the end. */
const pageOf = (search: Search, order: ReadonlyArray<{ readonly file: number }>): SearchPage => ({
  matches: search.matches,
  skipped: search.skipped,
  next: Option.getOrElse(search.next, () =>
    Option.getOrNull(Option.map(Arr.get(order, filesPerPage), ({ file }) => ({ file, line: 0 }))),
  ),
});

/**
 * One page of a literal line search over a fixed list of files, starting at `start`. `readBytes`
 * resolves and reads one file; its {@link PathRejected} or {@link TextFileRejected} failures are
 * reported as skipped (a file that vanished is dropped silently).
 *
 * A file whose bytes do not contain a case-sensitive query cannot match, so it is not decoded, and
 * a binary or non-UTF-8 file is only reported as skipped when it might have matched.
 */
type ReadFailure =
  | PathRejected
  | TextFileRejected
  | TextFileIoFailed
  | import("effect/PlatformError").PlatformError;

export interface SearchTextInput<R = never> extends SearchOptions {
  readonly paths: readonly string[];
  readonly readBytes: (path: string) => Effect.Effect<Uint8Array, ReadFailure, R>;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly start: SearchPosition;
  readonly readPage?: (path: string, startLine: number) => Effect.Effect<LinePage, ReadFailure, R>;
}

export const searchTextFilesEffect = Effect.fn("searchTextFiles")(function* <R>(
  input: SearchTextInput<R>,
): Effect.fn.Return<SearchPage, never, R> {
  if (input.readPage !== undefined && !input.query.includes("\n"))
    return yield* searchPagedFiles(input, input.readPage);
  const { paths, readBytes, query, caseSensitive, start } = input;
  const needle = caseSensitive ? query : query.toLowerCase();
  const needleBytes = Buffer.from(query, "utf8");
  const order = searchOrder(paths, start, input.candidates);

  const read = (path: string) =>
    readBytes(path).pipe(
      Effect.map((bytes): FileRead => FileRead.bytes({ bytes })),
      Effect.catchTags({
        PathRejected: (error) =>
          Effect.succeed<FileRead>(
            error.reason === "not_found"
              ? FileRead.gone()
              : FileRead.skipped({ reason: error.reason }),
          ),
        TextFileRejected: (error) =>
          Effect.succeed<FileRead>(
            FileRead.skipped({ reason: textFileRejectedReasonName(error.reason) }),
          ),
        PlatformError: (error) =>
          Effect.succeed<FileRead>(
            Predicate.isTagged(error.reason, "NotFound")
              ? FileRead.gone()
              : FileRead.skipped({ reason: "unreadable" }),
          ),
        TextFileIoFailed: (error) =>
          Effect.succeed<FileRead>(
            error.reason.code === "ENOENT"
              ? FileRead.gone()
              : FileRead.skipped({ reason: "unreadable" }),
          ),
      }),
    );
  const skip = (search: Search, skipped: SearchSkip): Search => ({
    ...search,
    skipped: [...search.skipped, skipped],
  });
  const matchText = (search: Search, path: string, file: number, text: string): Search => {
    const found = lineMatches(
      text,
      needle,
      caseSensitive,
      file === start.file ? start.line : 0,
      matchLimit - search.matches.length,
    ).map((found) => ({ path, line: found.line + 1, text: snippet(found.content, found.column) }));
    const collected = collect(search, found);
    return {
      ...collected.search,
      next: Option.map(collected.filledBy, (match) => {
        // Lines are counted as split on "\n": one more than the newlines.
        const totalLines = text.split("\n").length;
        const next =
          match.line < totalLines ? { file, line: match.line } : { file: file + 1, line: 0 };
        return next.file < paths.length ? next : null;
      }),
    };
  };
  const searched = yield* Stream.fromIterable(order.slice(0, filesPerPage)).pipe(
    // The next few reads run ahead, so the disk works while this file is matched.
    Stream.mapEffect(
      ({ path, file }) => Effect.map(read(path), (result) => ({ path, file, result })),
      { concurrency: readAhead + 1 },
    ),
    Stream.scanEffect(
      () => emptySearch,
      (search, { path, file, result }) =>
        FileRead.$match(result, {
          gone: () => Effect.succeed(search),
          skipped: ({ reason }) => Effect.succeed(skip(search, { path, reason })),
          bytes: ({ bytes }) =>
            caseSensitive &&
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needleBytes) < 0
              ? Effect.succeed(search)
              : Effect.match(decodeTextEffect({ bytes, path }), {
                  onFailure: (error) =>
                    skip(search, { path, reason: textFileRejectedReasonName(error.reason) }),
                  onSuccess: (text) => matchText(search, path, file, text),
                }),
        }),
    ),
    Stream.takeUntil((search) => Option.isSome(search.next)),
    Stream.runLast,
  );
  return pageOf(
    Option.getOrElse(searched, () => emptySearch),
    order,
  );
  // Reads still running when the page is done are interrupted, and their finalizers run with the page.
}, Effect.scoped);

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
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  Buffer.from(EffectFunction.flow(Schema.encodeResult(Cursor), Result.getOrThrow)(cursor)).toString(
    "base64url",
  );

export const decodeSearchCursor = (text: string) =>
  Option.getOrUndefined(
    Schema.decodeOption(Cursor)(Buffer.from(text, "base64url").toString("utf8")),
  );

/** Validates once per file revision, then reads only the next line range. No speculative handles. */
const searchPagedFiles = Effect.fnUntraced(function* <R>(
  input: SearchTextInput<R>,
  readPage: NonNullable<SearchTextInput<R>["readPage"]>,
): Effect.fn.Return<SearchPage, never, R> {
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  const order = searchOrder(input.paths, input.start, input.candidates);
  // A page that failed keeps the original binary/UTF-8 candidate filtering and skip semantics; a
  // long line may match beyond the preview. Both retain the bounded whole-file fallback.
  const fallback = (search: Search, file: number, path: string, line: number) =>
    Effect.map(
      searchTextFilesEffect({
        paths: [path],
        readBytes: input.readBytes,
        query: input.query,
        caseSensitive: input.caseSensitive,
        start: { file: 0, line },
      }),
      (fallback): Search => {
        const collected = collect(
          { ...search, skipped: [...search.skipped, ...fallback.skipped] },
          fallback.matches,
        );
        return {
          ...collected.search,
          next: Option.orElse(
            Option.map(collected.filledBy, (match) => ({ file, line: match.line })),
            () =>
              Option.map(Option.fromNullishOr(fallback.next), (next) => ({
                file,
                line: next.line,
              })),
          ),
        };
      },
    );
  const matchPage = (search: Search, file: number, path: string, line: number, page: LinePage) => {
    const found = lineMatches(
      page.content,
      needle,
      input.caseSensitive,
      0,
      matchLimit - search.matches.length,
    ).map((found) => ({
      path,
      line: line + found.line + 1,
      text: snippet(found.content, found.column),
    }));
    const collected = collect(search, found);
    return {
      ...collected.search,
      next: Option.map(collected.filledBy, (match) => {
        const next =
          match.line < page.totalLines ? { file, line: match.line } : { file: file + 1, line: 0 };
        return next.file < input.paths.length ? next : null;
      }),
    };
  };
  /** Searches one file page by page, from the line a resumed search stopped at. */
  const searchFile = (
    search: Search,
    { path, file }: { readonly path: string; readonly file: number },
  ) =>
    Stream.paginate(file === input.start.file ? input.start.line : 0, (line: number) =>
      Effect.result(readPage(path, line + 1)).pipe(
        Effect.map((result) => {
          // A whole page is followed by the next one; a fallback finishes the file itself.
          const next =
            Result.isSuccess(result) && !result.success.lineTruncated
              ? Option.map(Option.fromNullishOr(result.success.nextStartLine), (start) => start - 1)
              : Option.none();
          return [Arr.of({ line, result }), next] as const;
        }),
        Effect.tap(() => Effect.yieldNow),
      ),
    ).pipe(
      Stream.scanEffect(
        () => search,
        (search, { line, result }) =>
          Result.isFailure(result) || result.success.lineTruncated
            ? fallback(search, file, path, line)
            : Effect.succeed(matchPage(search, file, path, line, result.success)),
      ),
      Stream.takeUntil((search) => Option.isSome(search.next)),
      Stream.runLast,
      Effect.map(Option.getOrElse(() => search)),
    );
  const searched = yield* Stream.fromIterable(order.slice(0, filesPerPage)).pipe(
    Stream.scanEffect(() => emptySearch, searchFile),
    Stream.takeUntil((search) => Option.isSome(search.next)),
    Stream.runLast,
  );
  return pageOf(
    Option.getOrElse(searched, () => emptySearch),
    order,
  );
});
