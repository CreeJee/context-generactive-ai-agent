import { Data, Match, Option, Record, Schema } from "effect";
import { diagnosisFailureStatus } from "memory-agent/app-api";
import type { ReportDiagnosis, ReportDiagnosisFailure } from "memory-agent/definitions";
import { reportCopy } from "./copy";
import type { ReportRequestFailed } from "./report-client";

const copy = reportCopy.diagnosis;

/** The diagnosis lifecycle on the report page. Every state still allows sending the plain report. */
export type DiagnosisState = Data.TaggedEnum<{
  idle: {};
  running: {};
  ready: { readonly diagnosis: ReportDiagnosis; readonly included: boolean };
  failed: { readonly reason: ReportDiagnosisFailure | "request_failed" };
}>;
export const DiagnosisState = Data.taggedEnum<DiagnosisState>();

/** What the final report says about the diagnosis. */
export type DiagnosisText = Data.TaggedEnum<{
  none: {};
  failed: { readonly reason: ReportDiagnosisFailure | "request_failed" };
  included: { readonly diagnosis: ReportDiagnosis };
}>;
export const DiagnosisText = Data.taggedEnum<DiagnosisText>();

export const diagnosisText = DiagnosisState.$match({
  idle: (): DiagnosisText => DiagnosisText.none(),
  running: (): DiagnosisText => DiagnosisText.none(),
  failed: ({ reason }): DiagnosisText => DiagnosisText.failed({ reason }),
  ready: ({ included, diagnosis }): DiagnosisText =>
    included ? DiagnosisText.included({ diagnosis }) : DiagnosisText.none(),
});

export function diagnosisFailure(
  error: ReportRequestFailed | Schema.SchemaError,
): ReportDiagnosisFailure | "request_failed" {
  return Match.valueTags(error, {
    SchemaError: (): ReportDiagnosisFailure => "invalid_answer",
    // The contract answers each reason with its own status; the refused body is never read.
    ReportRequestFailed: ({ httpStatus }) =>
      Record.findFirst(diagnosisFailureStatus, (status) => status === httpStatus).pipe(
        Option.match({ onNone: () => "request_failed" as const, onSome: ([reason]) => reason }),
      ),
  });
}

function EditableList({
  title,
  items,
  cite,
  onChange,
}: {
  title: string;
  items: readonly { text: string; evidenceIds?: readonly string[] }[];
  cite: boolean;
  onChange: (index: number, text: string | null) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{title}</legend>
      {items.length === 0 && <p className="text-xs text-muted-foreground">{copy.none}</p>}
      {items.map((item, index) => (
        <div key={index} className="space-y-1">
          <textarea
            aria-label={`${title} ${index + 1}`}
            className="min-h-14 w-full rounded-md border bg-background p-2 text-sm"
            value={item.text}
            onChange={(event) => onChange(index, event.target.value)}
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {cite && item.evidenceIds && <span>{copy.evidence(item.evidenceIds.join(", "))}</span>}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => onChange(index, null)}
            >
              {copy.remove}
            </button>
          </div>
        </div>
      ))}
    </fieldset>
  );
}

/** Lets the user review and edit the model's diagnosis before it enters the report. */
export function ReportDiagnosisReview({
  state,
  onRequest,
  onChange,
}: {
  state: DiagnosisState;
  onRequest: () => void;
  onChange: (state: DiagnosisState) => void;
}) {
  return DiagnosisState.$match(state, {
    idle: () => (
      <div className="space-y-1">
        <button type="button" onClick={onRequest} className="rounded-md border px-3 py-2 text-sm">
          {copy.request}
        </button>
        <p className="text-xs text-muted-foreground">{copy.requestHint}</p>
      </div>
    ),
    running: () => (
      <p role="status" className="text-sm text-muted-foreground">
        {copy.running}
      </p>
    ),
    failed: ({ reason }) => (
      <div className="space-y-1 text-sm">
        <p role="status">{copy.failed(copy.failure[reason])}</p>
        <button type="button" onClick={onRequest} className="text-primary underline">
          {copy.retry}
        </button>
      </div>
    ),
    ready: (ready) => {
      const { diagnosis } = ready;
      const edit = (next: ReportDiagnosis) =>
        onChange(DiagnosisState.ready({ ...ready, diagnosis: next }));
      return (
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ready.included}
              onChange={(event) =>
                onChange(DiagnosisState.ready({ ...ready, included: event.target.checked }))
              }
            />
            {copy.include}
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{copy.summary}</span>
            <textarea
              className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
              value={diagnosis.summary}
              onChange={(event) => edit({ ...diagnosis, summary: event.target.value })}
            />
          </label>
          <EditableList
            title={copy.observations}
            items={diagnosis.observations}
            cite
            onChange={(index, text) =>
              edit({
                ...diagnosis,
                observations:
                  text === null
                    ? diagnosis.observations.filter((_, at) => at !== index)
                    : diagnosis.observations.map((item, at) =>
                        at === index ? { ...item, text } : item,
                      ),
              })
            }
          />
          <EditableList
            title={copy.hypotheses}
            items={diagnosis.hypotheses}
            cite={false}
            onChange={(index, text) =>
              edit({
                ...diagnosis,
                hypotheses:
                  text === null
                    ? diagnosis.hypotheses.filter((_, at) => at !== index)
                    : diagnosis.hypotheses.map((item, at) => (at === index ? { text } : item)),
              })
            }
          />
          <button type="button" onClick={onRequest} className="text-sm text-primary underline">
            {copy.rerun}
          </button>
        </div>
      );
    },
  });
}
