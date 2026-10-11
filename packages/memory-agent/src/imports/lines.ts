import { Effect, FileSystem, Function as EffectFunction } from "effect";

/** 1 MiB at a time: big enough that a 20 MB transcript is a few dozen reads, small enough to hold. */
const chunkBytes = 1024 * 1024;
const newline = 0x0a;

export interface LinesRead {
  /** Where the next read starts: the end of the last complete line, never mid-line. */
  readonly offset: number;
  readonly lines: number;
}

/**
 * Reads complete lines from `offset` and hands each one to `onLine`, returning where to resume.
 *
 * A transcript of a running agent is being appended to while this reads it, so the tail may be half
 * a line; stopping at the last newline leaves it for the next pass. Offsets are bytes because that
 * is what a cursor can be compared against the file's size. Cutting only at a newline is safe for
 * UTF-8: that byte never appears inside a multi-byte character.
 */
const readLinesFromBody = Effect.fn("readLinesFrom")(function* (
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
        pending = combined;
        let start = 0;
        while (true) {
          const end = pending.indexOf(newline, start);
          if (end === -1) break;
          const line = decoder.decode(pending.subarray(start, end)).trim();
          if (line.length > 0) {
            onLine(line);
            lines += 1;
          }
          start = end + 1;
        }
        offset += start;
        pending = pending.subarray(start);
      }
      return { offset, lines } satisfies LinesRead;
    }),
  );
});

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
