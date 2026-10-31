/**
 * Why a state-changing request came from another site, or null when it did not (PRD R14). The app
 * is local, but any web page the user opens could otherwise POST to it.
 */
export function crossSiteRefusal(request: Request): "cross_site_request" | "invalid_origin" | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") return "cross_site_request";
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) return "invalid_origin";
  return null;
}

/** Refuses state-changing requests from other sites with 403 (`crossSiteRefusal`). */
export function rejectCrossSite(request: Request): Response | null {
  const refusal = crossSiteRefusal(request);
  return refusal === null ? null : Response.json({ error: refusal }, { status: 403 });
}
