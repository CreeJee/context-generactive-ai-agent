import { Effect, Schema } from "effect";
import { Nodes, type Node } from "../memory/nodes.ts";
import { EvaluationFailed } from "./failure.ts";
import { MemoryAnswer } from "./memory-answer.ts";

const decodeMemoryAnswer = Schema.decodeEffect(Schema.fromJsonString(MemoryAnswer), {
  onExcessProperty: "error",
});

export const MemoryCorrection = Schema.Struct({
  projectId: Schema.String,
  sessionId: Schema.String,
  text: Schema.String,
  decision: Schema.String,
});
export type MemoryCorrection = typeof MemoryCorrection.Type;

/** Captured from the correction turn, before asking the model for its answer. */
export const MemoryEvidence = Schema.Struct({ id: Schema.String, ...MemoryCorrection.fields });
export type MemoryEvidence = typeof MemoryEvidence.Type;

function matchesCorrection(source: Node | null, expected: MemoryCorrection): boolean {
  return (
    source !== null &&
    source.kind === "user" &&
    source.projectId === expected.projectId &&
    source.sessionId === expected.sessionId &&
    source.text === expected.text
  );
}

export const captureMemoryEvidence = Effect.fn("Rrsi.captureMemoryEvidence")(function* (
  expected: MemoryCorrection,
): Effect.fn.Return<MemoryEvidence, EvaluationFailed, Nodes> {
  const nodes = yield* Nodes;
  // Nodes exposes synchronous native SQLite reads; convert exceptions at this boundary.
  const source = yield* Effect.try({
    try: () => nodes.latestOfKind(expected.sessionId, "user"),
    catch: () => EvaluationFailed.make({ reason: "trial_execution_failed" }),
  });
  if (source === null || !matchesCorrection(source, expected)) {
    return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
  }
  return { id: source.id, ...expected };
});

export const scoreMemoryAnswer = Effect.fn("Rrsi.scoreMemoryAnswer")(function* (
  answer: MemoryAnswer,
  expected: MemoryEvidence,
): Effect.fn.Return<boolean, EvaluationFailed, Nodes> {
  if (
    answer.decision !== expected.decision ||
    answer.evidenceIds.length !== 1 ||
    answer.evidenceIds[0] !== expected.id
  ) {
    return false;
  }
  const nodes = yield* Nodes;
  // Nodes exposes synchronous native SQLite reads; convert exceptions at this boundary.
  const source = yield* Effect.try({
    try: () => nodes.get(expected.id),
    catch: () => EvaluationFailed.make({ reason: "trial_execution_failed" }),
  });
  return source !== null && source.id === expected.id && matchesCorrection(source, expected);
});

export const evaluateMemoryAnswer = Effect.fn("Rrsi.evaluateMemoryAnswer")(
  function* (text: string, expected: MemoryEvidence) {
    const answer = yield* decodeMemoryAnswer(text);
    return yield* scoreMemoryAnswer(answer, expected);
  },
  // Only invalid model output scores zero. Storage failures and interruption propagate.
  Effect.catchTag("SchemaError", () => Effect.succeed(false)),
);
