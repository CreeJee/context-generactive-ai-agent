import { Array as Arr, Option, Schema, SchemaAST } from "effect";
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api";

/**
 * What the app's HTTP APIs refuse with, shared by `ChatApi` and `AppApi`: the code under `error`,
 * any fields the code carries, and the status it is answered with. This module imports no server
 * code, so the browser bundle can use it.
 */

/** Refusals that carry `fields` beside the code: one of `codes` under `error`, answered `status`. */
export const refusalWith =
  <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  <const Codes extends readonly [string, ...Array<string>]>(status: number, codes: Codes) =>
    Schema.Struct({ error: Schema.Literals(codes), ...fields }).pipe(HttpApiSchema.status(status));

/** What an app API refusal carries beside its code: for some codes a reason the page shows. */
export const appRefusalFields = { reason: Schema.optionalKey(Schema.String) };

const annotatedStatus = SchemaAST.resolveAt<number>("httpApiStatus");

/** The HTTP status a refusal of `refusals` is answered with, or 500 when none matches. */
export const refusalStatusIn =
  (refusals: ReadonlyArray<Schema.Top>) =>
  (refused: { readonly error: string }): number =>
    Arr.findFirst(refusals, (schema) => Schema.is(schema)(refused)).pipe(
      Option.flatMapNullishOr((schema) => annotatedStatus(schema.ast)),
      Option.getOrElse(() => 500),
    );

const Forbidden = refusalWith({})(403, ["cross_site_request", "invalid_origin"]);

/** Refuses a request that changes something when another site sent it (PRD R14). */
export class SameSite extends HttpApiMiddleware.Service<SameSite>()(
  "memory-agent/api/refusal/SameSite",
  { error: Forbidden },
) {}
