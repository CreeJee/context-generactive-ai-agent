import { Cause, Effect, Function, Result, Schema } from "effect";
import { logDefect } from "memory-agent";

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
export const readJson: {
  <A, I>(
    schema: Schema.Codec<A, I>,
  ): (request: Request) => Promise<Result.Result<A, Schema.SchemaError>>;
  <A, I>(
    request: Request,
    schema: Schema.Codec<A, I>,
  ): Promise<Result.Result<A, Schema.SchemaError>>;
} = Function.dual(2, <A, I>(request: Request, schema: Schema.Codec<A, I>) =>
  request
    .text()
    .then((text) =>
      Schema.decodeResult(Schema.fromJsonString(schema))(text.trim() === "" ? "{}" : text),
    ),
);

/**
 * Answers a defect with a fixed 500 code. The defect is logged without its cause, which can hold
 * paths, SQL or provider text, and goes to the defect reporter, which sends only a redacted
 * summary; typed failures and interruptions pass through.
 */
export const answerDefect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchDefect(effect, (defect) =>
    Effect.as(
      logDefect("route_defect")(Cause.die(defect)),
      Response.json({ error: "internal_error" }, { status: 500 }),
    ),
  );
