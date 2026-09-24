import { Semaphore } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { SQLOutputValue } from "node:sqlite";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { requireRuntime } from "../runtime/resources.ts";

/** Largest image accepted for upload. */
export const maxAttachmentBytes = 20 * 1024 * 1024;

export const AttachmentMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export type AttachmentMimeType = typeof AttachmentMimeType.Type;

export const Attachment = Schema.Struct({
  /** sha256 of the bytes, hex. */
  id: Schema.String,
  mimeType: AttachmentMimeType,
  bytes: Schema.Finite,
  createdAt: Schema.String,
});
export type Attachment = typeof Attachment.Type;

export class AttachmentRejected extends Data.TaggedError("AttachmentRejected")<{
  readonly reason: "empty" | "too_large" | "unsupported_type";
}> {}

export class AttachmentStorageFailed extends Data.TaggedError("AttachmentStorageFailed")<{
  readonly operation: "save" | "purge" | "convert";
  readonly cause: unknown;
}> {}

const AttachmentRow = Schema.Struct({
  id: Schema.String,
  mime_type: AttachmentMimeType,
  bytes: Schema.Finite,
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

/**
 * Longest side of the copy of an image sent to the model. The API scales larger images down to
 * fit within this anyway, so nothing it would have seen is lost.
 */
export const modelImageEdge = 2048;
/** Target ceiling for a model image; adaptive encoding trades detail only when the copy exceeds it. */
export const maxModelImageBytes = 2 * 1024 * 1024;
/** Sharp is memory hungry, so uploads and lazy migration fallbacks share this small process queue. */
const maxConcurrentImageConversions = 2;

/** Largest SVG turned into a picture; a figure is a few KB, anything near this is not a drawing. */
export const maxDrawingBytes = 2 * 1024 * 1024;

/** A stored image as it goes to the model: a smaller WebP copy, or the upload itself. */
export interface ModelImage {
  readonly path: string;
  readonly mimeType: AttachmentMimeType;
}

const extensions = new Map<AttachmentMimeType, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

const make = Effect.gen(function* () {
  const run = Effect.runPromiseWith(yield* Effect.context());
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

  const conversionPermits = yield* Semaphore.make(maxConcurrentImageConversions);

  /**
   * Fits an image into an adaptive WebP budget. A disk marker remembers that conversion brought no
   * benefit. GIFs keep their animation. Concurrent conversions use distinct temporary files and
   * atomically publish the same content-addressed copy.
   */
  const encodeForModel = async (attachment: Attachment): Promise<ModelImage> => {
    const upload: ModelImage = { path: fileOf(attachment), mimeType: attachment.mimeType };
    if (attachment.mimeType === "image/gif") return upload;
    const copy = join(directory, `${attachment.id}.model.webp`);
    const noCopy = join(directory, `${attachment.id}.model-original`);
    const existingCopy = await stat(copy).catch(() => undefined);
    if (existingCopy && existingCopy.size <= maxModelImageBytes)
      return { path: copy, mimeType: "image/webp" };
    if (existingCopy) await rm(copy, { force: true });
    if (await stat(noCopy).catch(() => undefined)) return upload;
    try {
      const encoded = await run(
        conversionPermits.withPermits(1)(
          Effect.tryPromise({
            try: async () => {
              const sharp = requireRuntime("sharp");
              const attempts = [
                { edge: modelImageEdge, quality: 86 },
                { edge: 1600, quality: 78 },
                { edge: 1280, quality: 70 },
                { edge: 1024, quality: 64 },
              ] as const;
              let candidate: Uint8Array = new Uint8Array();
              for (const attempt of attempts) {
                candidate = await sharp(upload.path)
                  .rotate()
                  .resize({
                    width: attempt.edge,
                    height: attempt.edge,
                    fit: "inside",
                    withoutEnlargement: true,
                  })
                  .webp({ quality: attempt.quality, smartSubsample: true })
                  .toBuffer();
                if (candidate.length <= maxModelImageBytes) break;
              }
              return candidate;
            },
            catch: (cause) => new AttachmentStorageFailed({ operation: "convert", cause }),
          }),
        ),
      );
      if (encoded.length >= attachment.bytes) {
        await writeFile(noCopy, "", { mode: 0o600 });
        return upload;
      }
      const temporary = `${copy}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
        await rename(temporary, copy);
      } finally {
        await rm(temporary, { force: true });
      }
      return { path: copy, mimeType: "image/webp" };
    } catch {
      return upload;
    }
  };

  const forModel = encodeForModel;

  /**
   * Stores an image by content hash (storing the same image twice keeps one copy). The type comes
   * from the bytes, never from whoever supplied them.
   */
  const save = (bytes: Uint8Array) =>
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
      yield* Effect.tryPromise({
        try: async () => {
          const existing = await stat(path).catch(() => undefined);
          if (existing?.size === bytes.length) return;
          const temporary = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
        },
        catch: (cause) => new AttachmentStorageFailed({ operation: "save", cause }),
      });
      insertAttachment.run(
        attachment.id,
        attachment.mimeType,
        attachment.bytes,
        attachment.createdAt,
      );
      const stored = get(attachment.id) ?? attachment;
      // Start eagerly without retaining the upload request buffer while Sharp waits in the queue.
      // An immediate chat call joins this same in-flight conversion through forModel.
      void forModel(stored);
      return stored;
    });

  /**
   * Renders an SVG to PNG and stores the picture: what a drawing looked like when it was written.
   *
   * The SVG is handed to the renderer as bytes, never as a path, and that is what keeps this safe.
   * With no base location, librsvg refuses every external reference — `file://` URLs, absolute and
   * relative paths, remote URLs — so an SVG that points at a local file cannot copy it into the
   * picture. Given a path, it would resolve references next to it. Scripts in an SVG never run
   * while rasterising, and the SVG itself is never served from this app's origin.
   */
  const saveDrawing = (svg: Uint8Array) =>
    Effect.gen(function* () {
      if (svg.length === 0) return yield* new AttachmentRejected({ reason: "empty" });
      if (svg.length > maxDrawingBytes)
        return yield* new AttachmentRejected({ reason: "too_large" });
      const png = yield* Effect.tryPromise({
        try: () =>
          requireRuntime("sharp")(Buffer.from(svg), { density: 144 })
            .resize({
              width: modelImageEdge,
              height: modelImageEdge,
              fit: "inside",
              withoutEnlargement: true,
            })
            .png()
            .toBuffer(),
        catch: () => new AttachmentRejected({ reason: "unsupported_type" }),
      });
      return yield* save(png);
    });

  return {
    save,
    saveDrawing,
    get,

    /** Absolute path of a stored image as uploaded. */
    pathOf: fileOf,

    read: (attachment: Attachment) => readFile(fileOf(attachment)),

    /** Model derivative, eagerly made on upload with a lazy fallback for pre-existing files. */
    forModel,

    /** `data:` URL of an image file, for replaying earlier turns to the model. */
    dataUrl: async (image: ModelImage) =>
      `data:${image.mimeType};base64,${(await readFile(image.path)).toString("base64")}`,

    /** Records the images a message carried, in order. */
    link: (nodeId: string, attachments: readonly Attachment[]) => {
      for (const [position, attachment] of attachments.entries())
        insertLink.run(nodeId, position, attachment.id);
    },

    forNode: (nodeId: string): Attachment[] => selectForNode.all(nodeId).map(toAttachment),

    /** Removes content-addressed blobs only after their last message reference is gone. */
    purgeOrphans: Effect.tryPromise({
      try: async () => {
        const orphaned = sqlite
          .prepare(
            `SELECT a.* FROM attachments a
           WHERE NOT EXISTS (SELECT 1 FROM node_attachments n WHERE n.attachment_id = a.id)`,
          )
          .all()
          .map(toAttachment);
        for (const attachment of orphaned) {
          sqlite.prepare("DELETE FROM attachments WHERE id = ?").run(attachment.id);
          await Promise.all([
            rm(fileOf(attachment), { force: true }),
            rm(join(directory, `${attachment.id}.model.webp`), { force: true }),
            rm(join(directory, `${attachment.id}.model-original`), { force: true }),
          ]);
        }
        return orphaned.length;
      },
      catch: (cause) => new AttachmentStorageFailed({ operation: "purge", cause }),
    }),
  };
});

export type AttachmentsApi = Effect.Success<typeof make>;

/** Images uploaded into conversations. Kept like the rest of the evidence: never expired. */
export class Attachments extends Context.Service<Attachments, AttachmentsApi>()(
  "memory-agent/Attachments",
) {
  static readonly layer = Layer.effect(Attachments, make);
}
