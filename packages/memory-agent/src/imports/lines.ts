import { closeSync, openSync, readSync } from "node:fs";

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
export function readLinesFrom(
  path: string,
  offset: number,
  onLine: (line: string) => void,
): LinesRead {
  const handle = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let position = offset;
    let pending = Buffer.alloc(0);
    let lines = 0;
    for (;;) {
      const read = readSync(handle, chunk, 0, chunkBytes, position);
      if (read === 0) break;
      position += read;
      pending = Buffer.concat([pending, chunk.subarray(0, read)]);
      let start = 0;
      for (;;) {
        const end = pending.indexOf(newline, start);
        if (end === -1) break;
        const line = pending.subarray(start, end).toString("utf8").trim();
        if (line.length > 0) {
          onLine(line);
          lines += 1;
        }
        start = end + 1;
      }
      offset += start;
      pending = pending.subarray(start);
    }
    return { offset, lines };
  } finally {
    closeSync(handle);
  }
}
