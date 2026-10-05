import { Effect, Schema } from "effect";
import { EvaluationFailed } from "./failure.ts";

const Chunk = Schema.Struct({ type: Schema.String, delta: Schema.optionalKey(Schema.String) });

// HTTP success only opens the stream. A RUN_ERROR or truncated stream is not a scored trial.
export const readTrialAnswer = Effect.fn("Rrsi.readTrialAnswer")(function* (stream: string) {
  let finished = false;
  const text: string[] = [];
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Chunk))(
      line.slice(6),
    ).pipe(Effect.mapError(() => new EvaluationFailed({ reason: "protocol_invalid" })));
    switch (chunk.type) {
      case "RUN_ERROR":
        return yield* new EvaluationFailed({ reason: "trial_execution_failed" });
      case "RUN_FINISHED":
        finished = true;
        break;
      case "TEXT_MESSAGE_CONTENT":
        if (chunk.delta) text.push(chunk.delta);
        break;
    }
  }
  if (!finished) return yield* new EvaluationFailed({ reason: "evaluation_incomplete" });
  return text.join("");
});
