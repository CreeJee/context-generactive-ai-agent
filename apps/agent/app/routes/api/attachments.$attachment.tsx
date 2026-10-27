import { isTruthy } from "../../truthy.ts";
import { Effect, Schema } from "effect";
import { Attachments } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/attachments.$attachment";

/** A stored image's file could not be read; the file system's text stays on the server. */
class AttachmentUnreadable extends Schema.TaggedError<AttachmentUnreadable>()(
  "AttachmentUnreadable",
  {},
) {}

/**
 * GET /api/attachments/:attachment — a stored image. Other sites cannot embed it: images are
 * conversation evidence, not public assets.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request, params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const site = request.headers.get("Sec-Fetch-Site");
      if (site === "cross-site")
        return Response.json({ error: "cross_site_request" }, { status: 403 });

      const found = yield* Effect.flatMap(Attachments, (attachments) =>
        Effect.gen(function* () {
          const attachment = yield* attachments.get(params.attachment);
          return isTruthy(attachment)
            ? {
                attachment,
                bytes: yield* attachments
                  .read(attachment)
                  .pipe(Effect.mapError(() => AttachmentUnreadable.make({}))),
              }
            : null;
        }),
      );
      if (!isTruthy(found))
        return Response.json({ error: "attachment_not_found" }, { status: 404 });
      return new Response(new Uint8Array(found.bytes), {
        headers: {
          "Content-Type": found.attachment.mimeType,
          "Content-Length": String(found.attachment.bytes),
          // Content-addressed: the same id always has the same bytes.
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    }).pipe(
      Effect.catchTag("AttachmentUnreadable", () =>
        Effect.succeed(Response.json({ error: "attachment_unreadable" }, { status: 500 })),
      ),
    ),
  );
}
