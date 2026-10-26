import { EventType, type StreamChunk } from "@tanstack/ai";
import { Cause, Clock, Effect, Function as EffectFunction, Schema, Stream } from "effect";
import type { AgUiEvent } from "../loop/chunks.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import type { SecretRedactor } from "../secrets/redactor.ts";
import { RepeatedToolCall } from "../tools/repeat-guard.ts";

/**
 * A run's chunks with each `RUN_ERROR` message (the provider's or the agent's own text) cut short
 * and its secrets hidden, before the page, the editor or the durable log reads it. The code is
 * kept; the page words it and shows the message only under the error's details.
 */
export const withShownRunErrors: {
  (
    chunks: AsyncIterable<StreamChunk>,
  ): (redactor: SecretRedactor["Service"]) => ReturnType<typeof withShownRunErrorsBody>;
} & typeof withShownRunErrorsBody = EffectFunction.dual(2, withShownRunErrorsBody);
function withShownRunErrorsBody(
  redactor: SecretRedactor["Service"],
  chunks: AsyncIterable<StreamChunk>,
) {
  return nativeStream(
    Stream.fromAsyncIterable(chunks, (cause) => new Cause.UnknownError(cause)).pipe(
      // A run the repeat guard stopped ends with its own code; thrown, the SDK words it as unknown.
      Stream.catchTag("UnknownError", (error) => {
        const stopped = error.cause;
        return Schema.is(RepeatedToolCall)(stopped)
          ? Stream.fromEffect(
              Effect.map(Clock.currentTimeMillis, (timestamp): StreamChunk => ({
                type: EventType.RUN_ERROR,
                runId: stopped.runId,
                threadId: stopped.threadId,
                timestamp,
                code: stopped.code,
                message: stopped.message,
              })),
            )
          : Stream.fail(error);
      }),
      Stream.mapEffect((chunk): Effect.Effect<StreamChunk> => {
        switch (chunk.type) {
          case "RUN_ERROR":
            return Effect.map(redactor.shownDetail(chunk.message), (message) => ({
              ...chunk,
              message: message ?? "detail withheld",
            }));
          default:
            return Effect.succeed(chunk);
        }
      }),
    ),
  );
}

/**
 * {@link withShownRunErrors} for the events of the Effect AI loop. A run the repeat guard stopped
 * already ends with its own code there.
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
