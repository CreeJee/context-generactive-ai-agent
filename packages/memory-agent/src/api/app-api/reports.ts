import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ReportBundle } from "../../report/bundle-contract.ts";
import {
  ReportDeliveryFailure,
  ReportDeliveryResult,
  ReportDeliveryStatus,
} from "../../report/delivery-contract.ts";
import {
  ReportDiagnosis,
  ReportDiagnosisFailure,
  ReportDiagnosisInput,
} from "../../report/diagnosis-contract.ts";
import { NoStore } from "../no-store.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A project or conversation id as a report request names it; the server checks they belong together. */
const ReportIdentifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));

/** The conversation a report is about, in the project the page shows it under. */
export const OpenReportSession = Schema.Struct({
  projectId: ReportIdentifier,
  sourceSessionId: ReportIdentifier,
});
export type OpenReportSession = typeof OpenReportSession.Type;

/** The report's own conversation, opened once per reported conversation. */
export const ReportSessionOpened = Schema.Struct({
  reportSessionId: Schema.String,
  sourceSessionId: Schema.String,
  projectId: Schema.String,
});
export type ReportSessionOpened = typeof ReportSessionOpened.Type;

/**
 * Sends the reviewed report once, with the evidence bundle the user previewed; `resend` confirms a
 * text that was or may have been sent already. `defect_reports` turns sending defects on or off.
 */
export const ReportDeliveryCommand = Schema.TaggedUnion({
  send: {
    text: Schema.String,
    evidence: Schema.NullOr(ReportBundle),
    resend: Schema.Boolean,
  },
  defect_reports: { enabled: Schema.Boolean },
});
export type ReportDeliveryCommand = typeof ReportDeliveryCommand.Type;

/** One status per reason, so the page tells the reasons apart without reading a refused body. */
export const deliveryFailureStatus = {
  not_configured: 409,
  invalid_webhook_url: 503,
  too_large: 413,
  in_progress: 423,
  rate_limited: 429,
  webhook_rejected: 410,
  payload_rejected: 422,
  discord_unavailable: 502,
  uncertain: 504,
} satisfies Record<ReportDeliveryFailure, number>;

/** One status per reason, so the page tells the reasons apart without reading a refused body. */
export const diagnosisFailureStatus = {
  model_unavailable: 503,
  model_failed: 502,
  invalid_answer: 422,
} satisfies Record<ReportDiagnosisFailure, number>;

/** The report did not reach the webhook; `reason` says why, and the status names it alone. */
const DeliveryFailed = ReportDeliveryFailure.literals.map((reason) =>
  refusalWith({ reason: Schema.Literal(reason) })(deliveryFailureStatus[reason], [
    "report_delivery_failed",
  ]),
);

/** The model gave no usable diagnosis; `reason` says why, and the status names it alone. */
const DiagnosisFailed = ReportDiagnosisFailure.literals.map((reason) =>
  refusalWith({ reason: Schema.Literal(reason) })(diagnosisFailureStatus[reason], [
    "report_diagnosis_failed",
  ]),
);

/** The conversation is not in that project, or is itself a report's. */
const ReportSourceNotFound = appRefusal(404, ["report_source_not_found"]);

/** The conversation is not in that project. */
const UnknownSession = appRefusal(404, ["session_not_found"]);

/** Reading the conversation's evidence failed; the cause stays on the server. */
const EvidenceUnavailable = appRefusal(503, ["evidence_unavailable"]);

/** The settings could not be read or written. */
const SettingsUnavailable = appRefusal(500, ["settings_unavailable"]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const reportsRefusals = [
  ...DeliveryFailed,
  ...DiagnosisFailed,
  ReportSourceNotFound,
  UnknownSession,
  EvidenceUnavailable,
  SettingsUnavailable,
];

/**
 * The problem report page (`/api/reports/*`). Every answer is `no-store`. The page reads a refusal
 * by its status alone, so each status names one reason.
 */
export class ReportsGroup extends HttpApiGroup.make("reports")
  .add(
    /** Opens the report's own conversation for a conversation; no run starts, the source stays. */
    HttpApiEndpoint.post("openSession", "/api/reports/sessions", {
      payload: OpenReportSession,
      success: ReportSessionOpened,
      error: ReportSourceNotFound,
    }),
    /**
     * The conversation's evidence bundle, collected whole, redacted and cut to its limits. The ids
     * are no authority: the conversation must be in the project.
     */
    HttpApiEndpoint.get("evidence", "/api/reports/evidence", {
      query: { project: ReportIdentifier, session: ReportIdentifier },
      success: ReportBundle,
      error: [UnknownSession, EvidenceUnavailable],
    }),
    /**
     * A diagnosis of the reviewed draft by the selected model. Only the description and evidence
     * the user included are sent; a failure leaves the plain report usable.
     */
    HttpApiEndpoint.post("diagnose", "/api/reports/diagnosis", {
      payload: ReportDiagnosisInput,
      success: ReportDiagnosis,
      error: DiagnosisFailed,
    }),
    /** Whether the server has a developer webhook, and whether defects go to it. Never the URL. */
    HttpApiEndpoint.get("deliveryStatus", "/api/reports/delivery", {
      success: ReportDeliveryStatus,
      error: SettingsUnavailable,
    }),
    /** Sends the report, or turns sending defects on or off; the webhook comes from the server. */
    HttpApiEndpoint.post("deliver", "/api/reports/delivery", {
      payload: ReportDeliveryCommand,
      success: [ReportDeliveryResult, ReportDeliveryStatus],
      error: [...DeliveryFailed, SettingsUnavailable],
    }),
  )
  .middleware(SameSite)
  .middleware(NoStore) {}
