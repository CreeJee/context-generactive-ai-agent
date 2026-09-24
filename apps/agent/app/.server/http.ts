import { Schema } from "effect";

/**
 * Refuses state-changing requests from other sites (PRD R14). The app is local, but any web page
 * the user opens could otherwise POST to it.
 */
export function rejectCrossSite(request: Request): Response | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none")
    return Response.json({ error: "cross_site_request" }, { status: 403 });
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin)
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  return null;
}

/** Decodes a JSON body; an empty body decodes as `{}` so optional-only schemas accept it. */
export async function readJson<A, I>(request: Request, schema: Schema.Codec<A, I>) {
  const text = await request.text();
  return Schema.decodeResult(Schema.fromJsonString(schema))(text.trim() === "" ? "{}" : text);
}
