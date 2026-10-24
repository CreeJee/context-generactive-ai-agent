import { EventType, type StreamChunk } from "@tanstack/ai";
import { Cause, Clock, Effect, Schema, Stream } from "effect";
import { nativeStream } from "../runtime/native-stream.ts";
import type { SecretRedactor } from "../secrets/redactor.ts";
import { RepeatedToolCall } from "../tools/repeat-guard.ts";

/**
 * A run's chunks with each `RUN_ERROR` message (the provider's or the agent's own text) cut short
 * and its secrets hidden, before the page, the editor or the durable log reads it. The code is
 * kept; the page words it and shows the message only under the error's details.
 */
export const withShownRunErrors = (
  redactor: SecretRedactor["Service"],
  chunks: AsyncIterable<StreamChunk>,
) =>
  nativeStream(
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
