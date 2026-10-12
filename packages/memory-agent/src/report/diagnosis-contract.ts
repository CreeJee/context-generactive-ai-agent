import { Schema } from "effect";

/** What the user chose to show the model: their own description and the evidence they included. */
export const ReportDiagnosisInput = Schema.Struct({
  sourceSessionId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  symptom: Schema.String.check(Schema.isMaxLength(4_000)),
  expected: Schema.String.check(Schema.isMaxLength(2_000)),
  actual: Schema.String.check(Schema.isMaxLength(2_000)),
  evidence: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMaxLength(256)),
      label: Schema.String.check(Schema.isMaxLength(200)),
      source: Schema.String.check(Schema.isMaxLength(500)),
      text: Schema.String.check(Schema.isMaxLength(6_000)),
    }),
  ).check(Schema.isMaxLength(20)),
});
export type ReportDiagnosisInput = typeof ReportDiagnosisInput.Type;

/** An observation cites at least one included evidence item; anything else is a hypothesis. */
export const ReportDiagnosis = Schema.Struct({
  observations: Schema.Array(
    Schema.Struct({ text: Schema.String, evidenceIds: Schema.Array(Schema.String) }),
  ),
  hypotheses: Schema.Array(Schema.Struct({ text: Schema.String })),
});
export type ReportDiagnosis = typeof ReportDiagnosis.Type;

/** Why no diagnosis came back; the plain report stays usable in every case. */
export const ReportDiagnosisFailure = Schema.Literals([
  "model_unavailable",
  "model_failed",
  "invalid_answer",
]);
export type ReportDiagnosisFailure = typeof ReportDiagnosisFailure.Type;
