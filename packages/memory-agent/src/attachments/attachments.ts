import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { SQLOutputValue } from "node:sqlite";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";

/** Largest image accepted for upload. */
export const maxAttachmentBytes = 20 * 1024 * 1024;

export const AttachmentMimeType = Schema.Literal(
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
);
export type AttachmentMimeType = typeof AttachmentMimeType.Type;

export const Attachment = Schema.Struct({
  /** sha256 of the bytes, hex. */
  id: Schema.String,
  mimeType: AttachmentMimeType,
  bytes: Schema.Number,
  createdAt: Schema.String,
});
export type Attachment = typeof Attachment.Type;

export class AttachmentRejected extends Data.TaggedError("AttachmentRejected")<{
  readonly reason: "empty" | "too_large" | "unsupported_type";
}> {}

const AttachmentRow = Schema.Struct({
  id: Schema.String,
  mime_type: AttachmentMimeType,
  bytes: Schema.Number,
  created_at: Schema.String,
});
const decodeAttachmentRow = Schema.decodeUnknownSync(AttachmentRow);

function toAttachment(row: Record<string, SQLOutputValue>): Attachment {
  const decoded = decodeAttachmentRow(row);
  return {
    id: decoded.id,
    mimeType: decoded.mime_type,
    bytes: decoded.bytes,
    createdAt: decoded.created_at,
  };
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((value, index) => bytes[offset + index] === value);

/** The image type the bytes really are, from their signature; a declared type is not trusted. */
export function sniffImageType(bytes: Uint8Array): AttachmentMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
}

/** Attachment ids are sha256 hex digests; anything else never touches the filesystem. */
export const isAttachmentId = (id: string) => /^[0-9a-f]{64}$/.test(id);

const extensions = new Map<AttachmentMimeType, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const storage = yield* StorageRoot;
  const directory = join(storage.path, "attachments");
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const selectAttachment = sqlite.prepare("SELECT * FROM attachments WHERE id = ?");
  const insertAttachment = sqlite.prepare(
    "INSERT INTO attachments VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  );
  const insertLink = sqlite.prepare(
    "INSERT INTO node_attachments VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const selectForNode = sqlite.prepare(
    "SELECT a.* FROM node_attachments l JOIN attachments a ON a.id = l.attachment_id WHERE l.node_id = ? ORDER BY l.position",
  );

  const fileOf = (attachment: Attachment) =>
    join(directory, `${attachment.id}.${extensions.get(attachment.mimeType)}`);

  const get = (id: string): Attachment | null => {
    if (!isAttachmentId(id)) return null;
    const row = selectAttachment.get(id);
    return row ? toAttachment(row) : null;
  };

  return {
    /**
     * Stores an uploaded image by content hash (uploading the same image twice keeps one copy).
     * The type comes from the bytes, never from the client.
     */
    save: (bytes: Uint8Array) =>
      Effect.gen(function* () {
        if (bytes.length === 0) return yield* new AttachmentRejected({ reason: "empty" });
        if (bytes.length > maxAttachmentBytes)
          return yield* new AttachmentRejected({ reason: "too_large" });
        const mimeType = sniffImageType(bytes);
        if (!mimeType) return yield* new AttachmentRejected({ reason: "unsupported_type" });

        const attachment: Attachment = {
          id: createHash("sha256").update(bytes).digest("hex"),
          mimeType,
          bytes: bytes.length,
          createdAt: new Date().toISOString(),
        };
        const path = fileOf(attachment);
        yield* Effect.promise(async () => {
          const existing = await stat(path).catch(() => undefined);
          if (existing?.size === bytes.length) return;
          const temporary = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
        });
        insertAttachment.run(
          attachment.id,
          attachment.mimeType,
          attachment.bytes,
          attachment.createdAt,
        );
        return get(attachment.id) ?? attachment;
      }),

    get,

    /** Absolute path of a stored image, for codex `localImage` input. */
    pathOf: fileOf,

    read: (attachment: Attachment) => readFile(fileOf(attachment)),

    /** `data:` URL of a stored image, for replaying earlier turns to the model. */
    dataUrl: async (attachment: Attachment) =>
      `data:${attachment.mimeType};base64,${(await readFile(fileOf(attachment))).toString("base64")}`,

    /** Records the images a message carried, in order. */
    link: (nodeId: string, attachments: readonly Attachment[]) => {
      for (const [position, attachment] of attachments.entries())
        insertLink.run(nodeId, position, attachment.id);
    },

    forNode: (nodeId: string): Attachment[] => selectForNode.all(nodeId).map(toAttachment),
  };
});

/** Images uploaded into conversations. Kept like the rest of the evidence: never expired. */
export class Attachments extends Context.Tag("memory-agent/Attachments")<
  Attachments,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(Attachments, make);
}
