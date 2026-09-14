/**
 * How a chat message refers to an uploaded image. Safe for the browser: the UI builds these URLs
 * for image parts, and the server maps them back to stored files.
 */
const prefix = "/api/attachments/";

export const attachmentUrl = (id: string) => `${prefix}${id}`;

/** The attachment id in an image part's URL, or null for anything that is not one of ours. */
export function attachmentIdOf(url: string): string | null {
  const id = url.startsWith(prefix) ? url.slice(prefix.length) : "";
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}
