import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AppEventFrame } from "../../events/contracts.ts";
import { NoStore } from "../no-store.ts";

const AppEventStream = HttpApiSchema.StreamSse({ events: AppEventFrame });

/**
 * Invalidation events the page follows with `EventSource` (`/api/events`,
 * `/api/projects/:project/events`, `/api/sessions/:session/events`). Each stream starts with
 * `ready` and holds no history: the page reloads what it read before the revision `ready` names.
 */
export class EventsGroup extends HttpApiGroup.make("events")
  .add(
    /** Every change of the app, on one connection. */
    HttpApiEndpoint.get("all", "/api/events", { success: AppEventStream }),
    /** The project's own changes. */
    HttpApiEndpoint.get("project", "/api/projects/:project/events", {
      params: { project: Schema.String },
      success: AppEventStream,
    }),
    /** The session's own changes. */
    HttpApiEndpoint.get("session", "/api/sessions/:session/events", {
      params: { session: Schema.String },
      success: AppEventStream,
    }),
  )
  .middleware(NoStore) {}
