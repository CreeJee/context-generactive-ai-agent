import { Effect } from "effect";
import { Attachments, maxAttachmentBytes } from "memory-agent";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/attachments._index";

/**
 * POST /api/attachments — the raw image bytes as the body. Stores the image by content hash and
 * returns `{ id, mimeType, bytes }`. The type is read from the bytes; only PNG, JPEG, GIF and
 * WebP up to 20 MiB are accepted.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > maxAttachmentBytes)
    return Response.json({ error: "attachment_rejected", reason: "too_large" }, { status: 413 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  const response = Effect.flatMap(Attachments, (attachments) => attachments.save(bytes)).pipe(
    Effect.map((attachment) => Response.json(attachment, { status: 201 })),
    Effect.catchTag("AttachmentRejected", (error) =>
      Effect.succeed(
        Response.json(
          { error: "attachment_rejected", reason: error.reason },
          { status: error.reason === "too_large" ? 413 : 422 },
        ),
      ),
    ),
  );
  return agent.runPromise(response);
}
