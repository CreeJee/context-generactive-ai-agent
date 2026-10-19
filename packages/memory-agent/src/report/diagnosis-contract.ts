import { Schema } from "effect";
import { ReportBundle } from "./bundle-contract.ts";

/** The user's own description and the evidence bundle they reviewed. */
export const ReportDiagnosisInput = Schema.Struct({
  sourceSessionId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  symptom: Schema.String.check(Schema.isMaxLength(4_000)),
  expected: Schema.String.check(Schema.isMaxLength(2_000)),
  actual: Schema.String.check(Schema.isMaxLength(2_000)),
  /** `null` when there was no session to collect from; the description alone is diagnosed. */
  bundle: Schema.NullOr(ReportBundle),
});
export type ReportDiagnosisInput = typeof ReportDiagnosisInput.Type;

/**
 * The model's reading of the bundle: a short summary for the report's opening, observations that
 * cite the bundle's places (`run-3/call-2`), and hypotheses. An observation without a citation of
 * a place in the bundle is a hypothesis.
 */
export const ReportDiagnosis = Schema.Struct({
  summary: Schema.String,
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
