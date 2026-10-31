import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { AppEvents } from "memory-agent";
import { AppApi } from "memory-agent/app-api";

/** The events group of `AppApi`: invalidation streams, ended when the page leaves or the server stops. */
export const EventsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "events",
  Effect.fn(function* (handlers) {
    const events = yield* AppEvents;
    return handlers.handleAll({
      all: () => events.allStream,
      project: ({ params: { project } }) => events.projectStream(project),
      session: ({ params: { session } }) => events.sessionStream(session),
    });
  }),
);
