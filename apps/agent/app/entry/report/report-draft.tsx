import { Data, Function as EffectFunction } from "effect";
import { BundleEvent, runHasFailure, runPlace, type ReportBundle } from "memory-agent/definitions";
import { reportCopy } from "./copy";
import { bundleGaps } from "./report-bundle";
import { DiagnosisText } from "./report-diagnosis";

const copy = reportCopy.report;
export interface ReportFields {
  symptom: string;
  expected: string;
  actual: string;
}

/** The evidence a draft describes: none was asked for (no session), it failed, or the bundle. */
export type DraftEvidence = Data.TaggedEnum<{
  none: {};
  failed: {};
  collected: { readonly bundle: ReportBundle };
}>;
export const DraftEvidence = Data.taggedEnum<DraftEvidence>();

const recentFailures = 5;

/** A few lines on the bundle for the draft itself; the bundle travels whole as an attachment. */
const evidenceLines = DraftEvidence.$match({
  none: () => [copy.noEvidence],
  failed: () => [copy.evidenceFailed],
  collected: ({ bundle }) => {
    const failing = bundle.timeline.items.filter(runHasFailure).slice(-recentFailures);
    return [
      copy.attachment(bundle.session.ref, bundle.timeline.items.length, bundle.session.runCount),
      copy.environment(bundle.environment),
      ...failing.map((run) => {
        const calls = run.events.flatMap((event) =>
          BundleEvent.guards.ToolCall(event) && event.result?.ok === false
            ? [`${runPlace(run)}/call-${event.seq} ${event.name ?? "?"}`]
            : [],
        );
        return `- ${runPlace(run)} ${run.status}${run.error === null ? "" : ` ${copy.runError(run.error.code ?? copy.noCode)}`}${calls.length > 0 ? `; ${copy.failedTools(calls.join(", "))}` : ""}`;
      }),
      ...bundle.defects.items
        .slice(0, recentFailures)
        .map(
          (defect) => `- ${reportCopy.bundle.defect(defect.tag, defect.location, defect.count)}`,
        ),
      ...bundleGaps(bundle).map((gap) => `- ${gap}`),
    ];
  },
});

export function reportText({
  fields,
  createdAt,
  evidence = DraftEvidence.none(),
  diagnosis = DiagnosisText.none(),
}: {
  readonly fields: ReportFields;
  readonly createdAt: string;
  readonly evidence?: DraftEvidence;
  readonly diagnosis?: DiagnosisText;
}): string {
  return [
    copy.heading,
    copy.createdAt(createdAt),
    "",
    copy.userHeading,
    copy.symptom(fields.symptom.trim() || copy.unwritten),
    copy.expected(fields.expected.trim() || copy.unwritten),
    copy.actual(fields.actual.trim() || copy.unwritten),
    "",
    ...diagnosisLines(diagnosis),
    "",
    copy.evidenceHeading,
    ...evidenceLines(evidence),
  ].join("\n");
}

/**
 * Text for copying or saving: the draft followed by the whole bundle, so a pasted report carries
 * the same evidence the webhook attaches.
 */
export const shareableText: {
  (evidence: DraftEvidence): (text: string) => string;
} & typeof shareableTextBody = EffectFunction.dual(2, shareableTextBody);
function shareableTextBody(text: string, evidence: DraftEvidence): string {
  return DraftEvidence.$match(evidence, {
    none: () => text,
    failed: () => text,
    collected: ({ bundle }) =>
      `${text}\n\n${copy.bundleHeading}\n${JSON.stringify(bundle, null, 2)}\n`,
  });
}

/** Model output stays apart from the user's text and evidence, with guesses labelled as such. */
const diagnosisLines = DiagnosisText.$match({
  none: () => [copy.diagnosisSkipped],
  failed: ({ reason }) => [copy.diagnosisFailed(reportCopy.diagnosis.failure[reason])],
  included: ({ diagnosis }) => {
    const { summary, observations, hypotheses } = diagnosis;
    return [
      copy.summaryHeading,
      summary.trim() || `- ${copy.none}`,
      "",
      copy.observationsHeading,
      ...(observations.length > 0
        ? observations.map(
            (item) =>
              `- ${item.text} (${reportCopy.diagnosis.evidence(item.evidenceIds.join(", "))})`,
          )
        : [`- ${copy.none}`]),
      "",
      copy.hypothesesHeading,
      ...(hypotheses.length > 0 ? hypotheses.map((item) => `- ${item.text}`) : [`- ${copy.none}`]),
    ];
  },
});

export function ReportDraft({
  fields,
  onChange,
  text,
  onTextChange,
}: {
  fields: ReportFields;
  onChange: (fields: ReportFields) => void;
  text: string;
  onTextChange: (text: string) => void;
}) {
  return (
    <div className="space-y-5">
      <section className="space-y-3" aria-label={reportCopy.draft.section}>
        <label className="block text-sm font-medium" htmlFor="report-symptom">
          {reportCopy.draft.symptom}
        </label>
        <textarea
          id="report-symptom"
          className="min-h-28 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.symptom}
          onChange={(event) => onChange({ ...fields, symptom: event.target.value })}
          placeholder={reportCopy.draft.symptomExample}
        />
        <label className="block text-sm font-medium" htmlFor="report-expected">
          {reportCopy.draft.expected}
        </label>
        <textarea
          id="report-expected"
          className="min-h-16 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.expected}
          onChange={(event) => onChange({ ...fields, expected: event.target.value })}
        />
        <label className="block text-sm font-medium" htmlFor="report-actual">
          {reportCopy.draft.actual}
        </label>
        <textarea
          id="report-actual"
          className="min-h-16 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.actual}
          onChange={(event) => onChange({ ...fields, actual: event.target.value })}
        />
      </section>
      <section className="space-y-2" aria-label={reportCopy.draft.textSection}>
        <label htmlFor="report-preview" className="block text-sm font-medium">
          {reportCopy.draft.text}
        </label>
        <textarea
          id="report-preview"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          className="min-h-60 w-full rounded-md border bg-background p-3 font-mono text-xs"
        />
      </section>
    </div>
  );
}
