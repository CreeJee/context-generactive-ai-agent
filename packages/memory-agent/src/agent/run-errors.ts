import { Effect, Function as EffectFunction, Stream } from "effect";
import type { AgUiEvent } from "../loop/chunks.ts";
import type { SecretRedactor } from "../secrets/redactor.ts";

/**
 * A run's chunks with each `RUN_ERROR` message (the provider's or the agent's own text) cut short
 * and its secrets hidden, before the page, the editor or the durable log reads it. The code is
 * kept; the page words it and shows the message only under the error's details.
 *
 * For the events of the Effect AI loop. A run the repeat guard stopped already ends with its own
 * code there.
 */
export const shownRunErrors: {
  (
    redactor: SecretRedactor["Service"],
  ): <E, R>(events: Stream.Stream<AgUiEvent, E, R>) => Stream.Stream<AgUiEvent, E, R>;
  <E, R>(
    events: Stream.Stream<AgUiEvent, E, R>,
    redactor: SecretRedactor["Service"],
  ): Stream.Stream<AgUiEvent, E, R>;
} = EffectFunction.dual(
  2,
  <E, R>(events: Stream.Stream<AgUiEvent, E, R>, redactor: SecretRedactor["Service"]) =>
    Stream.mapEffect(events, (event) =>
      event.type === "RUN_ERROR"
        ? Effect.map(redactor.shownDetail(event.message), (message): AgUiEvent => ({
            ...event,
            message: message ?? "detail withheld",
          }))
        : Effect.succeed(event),
    ),
);
