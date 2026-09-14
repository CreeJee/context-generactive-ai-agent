import { Effect } from "effect";
import { Attachments } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/attachments.$attachment";

/**
 * GET /api/attachments/:attachment — a stored image. Other sites cannot embed it: images are
 * conversation evidence, not public assets.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site") return Response.json({ error: "cross_site_request" }, { status: 403 });

  const found = await agent.runPromise(
    Effect.flatMap(Attachments, (attachments) =>
      Effect.promise(async () => {
        const attachment = attachments.get(params.attachment);
        return attachment ? { attachment, bytes: await attachments.read(attachment) } : null;
      }),
    ),
  );
  if (!found) return Response.json({ error: "attachment_not_found" }, { status: 404 });
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
}
