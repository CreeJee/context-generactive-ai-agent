import {
  Array as EffectArray,
  HashMap,
  Option,
  DateTime,
  Clock,
  Semaphore,
  Fiber,
  Scope,
  SynchronizedRef,
} from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SqlClient, SqlSchema } from "effect/sql";
import { StorageRoot } from "../config/storage-root.ts";
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

export class AttachmentRejected extends Schema.TaggedError<
  AttachmentRejected,
  { readonly brand: unique symbol }
>()("AttachmentRejected", {
  reason: Schema.Literals(["empty", "too_large", "unsupported_type"]),
}) {}

export class AttachmentStorageFailed extends Schema.TaggedError<
  AttachmentStorageFailed,
  { readonly brand: unique symbol }
>()("AttachmentStorageFailed", {
  operation: Schema.Literals(["save", "purge", "convert"]),
  cause: Schema.Defect(),
}) {}

const AttachmentRow = Schema.Struct({
  id: Schema.String,
  mime_type: AttachmentMimeType,
  bytes: Schema.Finite,
  created_at: Schema.String,
});
function toAttachment(decoded: typeof AttachmentRow.Type): Attachment {
  return {
    id: decoded.id,
    mimeType: decoded.mime_type,
    bytes: decoded.bytes,
    createdAt: decoded.created_at,
  };
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((value, index) => bytes[offset + index] === value);

/** Each image type's signature: bytes it holds at an offset (WebP's RIFF header names it at 8). */
const signatures = {
  "image/png": [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
  "image/jpeg": [[0, [0xff, 0xd8, 0xff]]],
  "image/gif": [[0, [0x47, 0x49, 0x46, 0x38]]],
  "image/webp": [
    [0, [0x52, 0x49, 0x46, 0x46]],
    [8, [0x57, 0x45, 0x42, 0x50]],
  ],
} satisfies Record<AttachmentMimeType, ReadonlyArray<readonly [number, readonly number[]]>>;

/** The image type the bytes really are, from their signature; a declared type is not trusted. */
export function sniffImageType(bytes: Uint8Array): AttachmentMimeType | null {
  return Option.getOrNull(
    EffectArray.findFirst(AttachmentMimeType.literals, (type) =>
      signatures[type].every(([offset, signature]) => startsWith(bytes, signature, offset)),
    ),
  );
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

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} satisfies Record<AttachmentMimeType, string>;

const make = Effect.gen(function* () {
  const conversionScope = yield* Scope.Scope;
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* StorageRoot;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directory = path.join(storage.path, "attachments");
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => AttachmentStorageFailed.make({ operation: "save", cause })));

  const selectAttachment = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AttachmentRow,
    execute: (id) => sql`SELECT * FROM attachments WHERE id = ${id}`,
  });
  const selectForNode = SqlSchema.findAll({
    Request: Schema.String,
    Result: AttachmentRow,
    execute: (nodeId) => sql`
      SELECT a.* FROM node_attachments l JOIN attachments a ON a.id = l.attachment_id
      WHERE l.node_id = ${nodeId} ORDER BY l.position`,
  });
  const selectSessionImages = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ held: Schema.Literals([0, 1]) }),
    execute: (sessionId) => sql`SELECT EXISTS (
      SELECT 1 FROM nodes n JOIN node_attachments l ON l.node_id = n.id
      WHERE n.session_id = ${sessionId} AND n.kind = 'user') AS held`,
  });
  // One statement decides and deletes, so a link added meanwhile keeps its blob.
  const deleteOrphans = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AttachmentRow,
    execute: () => sql`
      DELETE FROM attachments AS a
      WHERE NOT EXISTS (SELECT 1 FROM node_attachments n WHERE n.attachment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM btw_attachments b WHERE b.attachment_id = a.id)
      RETURNING *`,
  });

  const fileOf = (attachment: Attachment) =>
    path.join(directory, `${attachment.id}.${extensions[attachment.mimeType]}`);

  const get = (id: string) =>
    isAttachmentId(id)
      ? Effect.map(selectAttachment(id), (row) => Option.getOrNull(Option.map(row, toAttachment)))
      : Effect.succeed(null);

  const conversionPermits = yield* Semaphore.make(maxConcurrentImageConversions);

  /**
   * Fits an image into an adaptive WebP budget. A disk marker remembers that conversion brought no
   * benefit. GIFs keep their animation. Concurrent conversions use distinct temporary files and
   * atomically publish the same content-addressed copy.
   */
  const io = <A>(operation: AttachmentStorageFailed["operation"], execute: () => Promise<A>) =>
    Effect.tryPromise({
      try: execute,
      catch: (cause) => AttachmentStorageFailed.make({ operation, cause }),
    });

  const fileIo = <A>(
    operation: AttachmentStorageFailed["operation"],
    effect: Effect.Effect<A, import("effect/PlatformError").PlatformError>,
  ) => effect.pipe(Effect.mapError((cause) => AttachmentStorageFailed.make({ operation, cause })));

  const publish = Effect.fn("Attachments.publish")(function* (
    operation: AttachmentStorageFailed["operation"],
    destination: string,
    bytes: Uint8Array,
  ) {
    const temporary = `${destination}.${yield* fileIo(operation, crypto.randomUUIDv4())}.tmp`;
    return yield* Effect.acquireUseRelease(
      Effect.succeed(temporary),
      (temp) =>
        fileIo(operation, fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" })).pipe(
          Effect.andThen(fileIo(operation, fs.rename(temp, destination))),
        ),
      (temp) => fileIo(operation, fs.remove(temp, { force: true })),
    ).pipe(Effect.uninterruptible);
  });

  const encodeForModel = Effect.fn("Attachments.encodeForModel")(function* (
    attachment: Attachment,
  ): Effect.fn.Return<ModelImage> {
    const upload: ModelImage = { path: fileOf(attachment), mimeType: attachment.mimeType };
    if (attachment.mimeType === "image/gif") return upload;
    const copy = path.join(directory, `${attachment.id}.model.webp`);
    const noCopy = path.join(directory, `${attachment.id}.model-original`);
    return yield* Effect.gen(function* () {
      // A missing or unreadable file is treated as absent, as before.
      const existingCopy = yield* fs
        .stat(copy)
        .pipe(Effect.catchTag("PlatformError", () => Effect.void));
      if (existingCopy !== undefined && Number(existingCopy.size) <= maxModelImageBytes)
        return { path: copy, mimeType: "image/webp" as const };
      if (existingCopy !== undefined) yield* fileIo("convert", fs.remove(copy, { force: true }));
      const original = yield* fs
        .stat(noCopy)
        .pipe(Effect.catchTag("PlatformError", () => Effect.void));
      if (original !== undefined) return upload;
      const encoded = yield* Effect.gen(function* () {
        const sharp = yield* requireRuntime("sharp").pipe(
          Effect.mapError((cause) => AttachmentStorageFailed.make({ operation: "convert", cause })),
        );
        const [first, ...smaller] = [
          { edge: modelImageEdge, quality: 86 },
          { edge: 1600, quality: 78 },
          { edge: 1280, quality: 70 },
          { edge: 1024, quality: 64 },
        ] as const;
        const convert = (attempt: { readonly edge: number; readonly quality: number }) =>
          io("convert", () =>
            sharp(upload.path)
              .rotate()
              .resize({
                width: attempt.edge,
                height: attempt.edge,
                fit: "inside",
                withoutEnlargement: true,
              })
              .webp({ quality: attempt.quality, smartSubsample: true })
              .toBuffer(),
          );
        // A smaller attempt runs only while the previous one is still too large.
        const initial = yield* convert(first);
        return yield* Effect.reduce(
          smaller,
          () => initial,
          (candidate, attempt) =>
            candidate.length <= maxModelImageBytes ? Effect.succeed(candidate) : convert(attempt),
        );
      }).pipe(conversionPermits.withPermits(1));
      if (encoded.length >= attachment.bytes) {
        yield* fileIo("convert", fs.writeFileString(noCopy, "", { mode: 0o600 }));
        return upload;
      }
      yield* publish("convert", copy, encoded);
      return { path: copy, mimeType: "image/webp" as const };
    }).pipe(
      // Any conversion failure sends the original; the tag is logged, never paths or Sharp's text.
      Effect.catchTag("AttachmentStorageFailed", (error) =>
        Effect.as(
          Effect.logWarning("attachment_conversion_failed", { operation: error.operation }),
          upload,
        ),
      ),
    );
  });

  // The service owns native Sharp and filesystem work until it settles. These SDK operations
  // cannot be aborted safely midway through publishing their files.
  const conversions = yield* SynchronizedRef.make(HashMap.empty<string, Fiber.Fiber<ModelImage>>());
  const conversionFor = Effect.fn("Attachments.conversionFor")(function* (attachment: Attachment) {
    return yield* SynchronizedRef.modifyEffect(conversions, (running) =>
      Option.match(HashMap.get(running, attachment.id), {
        onSome: (fiber) => Effect.succeed([fiber, running] as const),
        onNone: () =>
          Effect.forkIn(
            encodeForModel(attachment).pipe(
              Effect.uninterruptible,
              // Waits for the lock, so it runs after the conversion was stored.
              Effect.ensuring(SynchronizedRef.update(conversions, HashMap.remove(attachment.id))),
            ),
            conversionScope,
            { startImmediately: true },
          ).pipe(
            Effect.map((fiber) => [fiber, HashMap.set(running, attachment.id, fiber)] as const),
          ),
      }),
    );
  });
  const forModel = (attachment: Attachment) =>
    Effect.flatMap(conversionFor(attachment), Fiber.join);
  const dataUrl = (image: ModelImage) =>
    fileIo("convert", fs.readFile(image.path)).pipe(
      Effect.map(
        (bytes) => `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      ),
    );

  /**
   * Stores an image by content hash (storing the same image twice keeps one copy). The type comes
   * from the bytes, never from whoever supplied them.
   */
  const save = (bytes: Uint8Array) =>
    Effect.gen(function* () {
      yield* Effect.when(
        Effect.fail(AttachmentRejected.make({ reason: "empty" })),
        Effect.succeed(bytes.length === 0),
      );
      yield* Effect.when(
        Effect.fail(AttachmentRejected.make({ reason: "too_large" })),
        Effect.succeed(bytes.length > maxAttachmentBytes),
      );
      const mimeType = yield* Effect.fromOption(Option.fromNullishOr(sniffImageType(bytes)), () =>
        AttachmentRejected.make({ reason: "unsupported_type" }),
      );

      const attachment: Attachment = {
        id: Hex.encode(yield* fileIo("save", crypto.digest("SHA-256", bytes))),
        mimeType,
        bytes: bytes.length,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      };
      const path = fileOf(attachment);
      const existing = yield* fs
        .stat(path)
        .pipe(Effect.catchTag("PlatformError", () => Effect.void));
      if (existing === undefined || Number(existing.size) !== bytes.length)
        yield* publish("save", path, bytes);
      yield* sql`
        INSERT INTO attachments
        VALUES (${attachment.id}, ${attachment.mimeType}, ${attachment.bytes}, ${attachment.createdAt})
        ON CONFLICT(id) DO NOTHING`;
      const stored = (yield* get(attachment.id)) ?? attachment;
      // Start eagerly without retaining the upload request buffer while Sharp waits in the queue.
      // An immediate chat call joins this same in-flight conversion through forModel.
      yield* conversionFor(stored);
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
      yield* Effect.when(
        Effect.fail(AttachmentRejected.make({ reason: "empty" })),
        Effect.succeed(svg.length === 0),
      );
      yield* Effect.when(
        Effect.fail(AttachmentRejected.make({ reason: "too_large" })),
        Effect.succeed(svg.length > maxDrawingBytes),
      );
      const sharp = yield* requireRuntime("sharp").pipe(
        Effect.mapError(() => AttachmentRejected.make({ reason: "unsupported_type" })),
      );
      const png = yield* Effect.tryPromise({
        try: () =>
          sharp(Buffer.from(svg), { density: 144 })
            .resize({
              width: modelImageEdge,
              height: modelImageEdge,
              fit: "inside",
              withoutEnlargement: true,
            })
            .png()
            .toBuffer(),
        catch: () => AttachmentRejected.make({ reason: "unsupported_type" }),
      });
      return yield* save(png);
    });

  return {
    save,
    saveDrawing,
    get,

    /** Absolute path of a stored image as uploaded. */
    pathOf: fileOf,

    read: (attachment: Attachment) =>
      fs.readFile(fileOf(attachment)).pipe(Effect.map((bytes) => Buffer.from(bytes))),

    /** Model derivative, eagerly made on upload with a lazy fallback for pre-existing files. */
    forModel,

    /** `data:` URL of an image file, for replaying earlier turns to the model. */
    dataUrl,

    /** Records the images a message carried, in order. */
    link: (nodeId: string, attachments: readonly Attachment[]) =>
      attachments.length === 0
        ? Effect.void
        : Effect.asVoid(sql`
            INSERT INTO node_attachments ${sql.insert(
              attachments.map((attachment, position) => ({
                node_id: nodeId,
                position,
                attachment_id: attachment.id,
              })),
            )}
            ON CONFLICT DO NOTHING`),

    forNode: (nodeId: string) =>
      Effect.map(selectForNode(nodeId), (rows) => rows.map(toAttachment)),

    /** Whether a user message of the session carried an image. */
    inSession: (sessionId: string) =>
      Effect.map(selectSessionImages(sessionId), ({ held }) => held === 1),

    /** Removes content-addressed blobs only after their last message reference is gone. */
    purgeOrphans: Effect.gen(function* () {
      const orphaned = (yield* deleteOrphans()).map(toAttachment);
      yield* Effect.forEach(
        orphaned,
        (attachment) =>
          Effect.forEach(
            [
              fileOf(attachment),
              path.join(directory, `${attachment.id}.model.webp`),
              path.join(directory, `${attachment.id}.model-original`),
            ],
            (path) => fileIo("purge", fs.remove(path, { force: true })),
            { concurrency: 3, discard: true },
          ),
        { discard: true },
      );
      return orphaned.length;
    }),
  };
});

export type AttachmentsApi = Effect.Success<typeof make>;

/** Images uploaded into conversations. Kept like the rest of the evidence: never expired. */
export class Attachments extends Context.Service<Attachments, AttachmentsApi>()(
  "memory-agent/attachments/attachments",
) {
  static readonly layer = Layer.effect(Attachments, make).pipe(
    Layer.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)),
  );
}
