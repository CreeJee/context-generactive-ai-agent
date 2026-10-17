import { Effect, FileSystem, Function as EffectFunction, Schema } from "effect";
// Effect has no zstd codec; Node's zlib decodes the archives Codex compresses its rollouts into.
import { zstdDecompress } from "node:zlib";

/** 1 MiB at a time: big enough that a 20 MB transcript is a few dozen reads, small enough to hold. */
const chunkBytes = 1024 * 1024;
const newline = 0x0a;

/** A compressed transcript: a whole file, written once, read as its decompressed bytes. */
const zstdSuffix = ".zst";

export class TranscriptDecompressFailed extends Schema.TaggedError<TranscriptDecompressFailed>()(
  "TranscriptDecompressFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {}

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
  let start = 0;
  let lines = 0;
  while (true) {
    const end = bytes.indexOf(newline, start);
    if (end === -1) break;
    const line = decoder.decode(bytes.subarray(start, end)).trim();
    if (line.length > 0) {
      onLine(line);
      lines += 1;
    }
    start = end + 1;
  }
  return { offset: start, lines };
}

const decompress = (path: string, compressed: Uint8Array) =>
  Effect.callback<Uint8Array, TranscriptDecompressFailed>((resume) => {
    zstdDecompress(compressed, (cause, decompressed) =>
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
  const bytes = yield* decompress(path, yield* fs.readFile(path));
  const read = completeLines(bytes.subarray(offset), new TextDecoder(), onLine);
  return { offset: offset + read.offset, lines: read.lines } satisfies LinesRead;
});

const readPlainLines = Effect.fn("readPlainLines")(function* (
  path: string,
  offset: number,
  onLine: (line: string) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(path, { flag: "r" });
      yield* handle.seek(BigInt(offset), "start");
      const chunk = new Uint8Array(chunkBytes);
      const decoder = new TextDecoder();
      let pending = new Uint8Array(0);
      let lines = 0;
      while (true) {
        const read = yield* handle.read(chunk);
        if (read === 0) break;
        const combined = new Uint8Array(pending.length + read);
        combined.set(pending);
        combined.set(chunk.subarray(0, read), pending.length);
        const complete = completeLines(combined, decoder, onLine);
        lines += complete.lines;
        offset += complete.offset;
        pending = combined.subarray(complete.offset);
      }
      return { offset, lines } satisfies LinesRead;
    }),
  );
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
