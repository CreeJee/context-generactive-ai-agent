import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Option,
  Schema,
  Stream,
} from "effect";
// Effect has no zstd codec; Node's zlib decodes the archives Codex compresses its rollouts into.
import { zstdDecompress } from "node:zlib";

/** 1 MiB at a time: big enough that a 20 MB transcript is a few dozen reads, small enough to hold. */
const chunkBytes = 1024 * 1024;
const newline = 0x0a;

/** A compressed transcript: a whole file, written once, read as its decompressed bytes. */
const zstdSuffix = ".zst";
/**
 * The most a compressed transcript may decompress to. A few kilobytes of zstd can expand to
 * gigabytes, and the whole result is held at once, so a larger one fails instead of taking memory.
 */
export const MaxDecompressedBytes = Context.Reference<number>(
  "memory-agent/imports/MaxDecompressedBytes",
  { defaultValue: () => 512 * 1024 * 1024 },
);

export class TranscriptDecompressFailed extends Schema.TaggedError<
  TranscriptDecompressFailed,
  { readonly brand: unique symbol }
>()("TranscriptDecompressFailed", { path: Schema.String, cause: Schema.Defect() }) {}

export interface LinesRead {
  /** Where the next read starts: the end of the last complete line, never mid-line. */
  readonly offset: number;
  readonly lines: number;
}

/** Hands each complete line in `bytes` to `onLine`; returns where the unfinished tail starts. */
function completeLines(
  bytes: Uint8Array,
  decoder: TextDecoder,
  onLine: (line: string) => void,
): LinesRead {
  const spans = Arr.unfold(0, (start) => {
    const end = bytes.indexOf(newline, start);
    return end === -1 ? Option.none() : Option.some([{ start, end }, end + 1] as const);
  });
  const lines = spans
    .map(({ start, end }) => decoder.decode(bytes.subarray(start, end)).trim())
    .filter((line) => line.length > 0);
  lines.forEach(onLine);
  return {
    offset: Option.match(Arr.last(spans), { onNone: () => 0, onSome: ({ end }) => end + 1 }),
    lines: lines.length,
  };
}

const decompress = (path: string, compressed: Uint8Array, maxBytes: number) =>
  Effect.callback<Uint8Array, TranscriptDecompressFailed>((resume) => {
    zstdDecompress(compressed, { maxOutputLength: maxBytes }, (cause, decompressed) =>
      resume(
        cause === null
          ? Effect.succeed(decompressed)
          : Effect.fail(TranscriptDecompressFailed.make({ path, cause })),
      ),
    );
  });

/** A `.zst` transcript is no longer appended to, so it is decompressed whole; its offset counts decompressed bytes. */
const readCompressedLines = Effect.fn("readCompressedLines")(function* (
  path: string,
  offset: number,
  onLine: (line: string) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* decompress(path, yield* fs.readFile(path), yield* MaxDecompressedBytes);
  const read = completeLines(bytes.subarray(offset), new TextDecoder(), onLine);
  return { offset: offset + read.offset, lines: read.lines } satisfies LinesRead;
});

const readPlainLines = Effect.fn("readPlainLines")(function* (
  path: string,
  offset: number,
  onLine: (line: string) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const decoder = new TextDecoder();
  // A line cut at a chunk's end is carried into the next chunk.
  const { read } = yield* fs.stream(path, { offset, chunkSize: chunkBytes }).pipe(
    Stream.runFold(
      () => ({ pending: new Uint8Array(0), read: { offset, lines: 0 } satisfies LinesRead }),
      ({ pending, read }, chunk) => {
        const combined = new Uint8Array(pending.length + chunk.length);
        combined.set(pending);
        combined.set(chunk, pending.length);
        const complete = completeLines(combined, decoder, onLine);
        return {
          pending: combined.subarray(complete.offset),
          read: { offset: read.offset + complete.offset, lines: read.lines + complete.lines },
        };
      },
    ),
  );
  return read;
});

/**
 * Reads complete lines from `offset` and hands each one to `onLine`, returning where to resume.
 *
 * A transcript of a running agent is being appended to while this reads it, so the tail may be half
 * a line; stopping at the last newline leaves it for the next pass. Offsets are bytes because that
 * is what a cursor can be compared against the file's size. Cutting only at a newline is safe for
 * UTF-8: that byte never appears inside a multi-byte character.
 */
const readLinesFromBody = (path: string, offset: number, onLine: (line: string) => void) =>
  path.endsWith(zstdSuffix)
    ? readCompressedLines(path, offset, onLine)
    : readPlainLines(path, offset, onLine);

export const readLinesFrom: {
  (
    path: string,
    offset: number,
    onLine: (line: string) => void,
  ): ReturnType<typeof readLinesFromBody>;
  (
    offset: number,
    onLine: (line: string) => void,
  ): (path: string) => ReturnType<typeof readLinesFromBody>;
} = EffectFunction.dual(3, readLinesFromBody);
