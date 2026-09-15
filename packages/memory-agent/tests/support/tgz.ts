import { gzipSync } from "node:zlib";

export interface TarEntry {
  readonly name: string;
  readonly content: string;
  /** Octal file mode, e.g. 0o755 for an executable. */
  readonly mode?: number;
}

const block = 512;

/** A gzipped ustar archive of regular files, byte-for-byte what `tar -czf` would give a reader. */
export function tgz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(block);
    const field = (offset: number, length: number, value: string) =>
      header.write(value, offset, length, "utf8");
    const octal = (offset: number, length: number, value: number) =>
      field(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
    field(0, 100, entry.name);
    octal(100, 8, entry.mode ?? 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, content.length);
    octal(136, 12, 0);
    header.fill(" ", 148, 156);
    field(156, 1, "0");
    field(257, 6, "ustar\0");
    field(263, 2, "00");
    let sum = 0;
    for (const byte of header) sum += byte;
    field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header, content, Buffer.alloc((block - (content.length % block)) % block));
  }
  parts.push(Buffer.alloc(block * 2));
  return gzipSync(Buffer.concat(parts));
}
