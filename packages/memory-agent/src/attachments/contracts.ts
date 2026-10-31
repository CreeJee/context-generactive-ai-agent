import { Schema } from "effect";

/**
 * A stored image as the page sees it. This module imports no server code, so the browser bundle can
 * use it.
 */

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
