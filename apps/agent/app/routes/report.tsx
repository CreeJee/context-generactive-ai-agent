import { Data, DateTime, Effect, Fiber } from "effect";
import { isTruthy } from "../truthy.ts";
import type { ReportBundle } from "memory-agent/definitions";
import { useEffect, useRef, useState } from "react";
import {
  ReportDraft,
  reportText,
  shareableText,
  DraftEvidence,
  type ReportFields,
} from "../entry/report/report-draft";
import { ReportBundlePreview } from "../entry/report/report-bundle";
import { copyReportText } from "../entry/report/report-copy";
import { ReportDelivery } from "../entry/report/report-delivery";
import {
  openReportSession,
  readReportEvidence,
  requestDiagnosis,
} from "../entry/report/report-client";
import {
  ReportDiagnosisReview,
  diagnosisFailure,
  diagnosisText,
  DiagnosisState,
} from "../entry/report/report-diagnosis";
import { reportCopy } from "../entry/report/copy";
import { problemText } from "../entry/shared/copy-templates";

const pageCopy = reportCopy.page;

/** The evidence bundle on the page: collected on open when the report names a session. */
type EvidenceState = Data.TaggedEnum<{
  none: {};
  failed: {};
  collected: { readonly bundle: ReportBundle };
  loading: {};
}>;
const EvidenceState = Data.taggedEnum<EvidenceState>();

const draftEvidence = EvidenceState.$match({
  loading: () => DraftEvidence.none(),
  none: () => DraftEvidence.none(),
  failed: () => DraftEvidence.failed(),
  collected: ({ bundle }) => DraftEvidence.collected({ bundle }),
});

const reportSource = () => {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const session = params.get("session");
  return isTruthy(project) && isTruthy(session) ? { project, session } : null;
};

export function meta() {
  return [{ title: pageCopy.title }];
}

export default function ReportPage() {
  const [fields, setFields] = useState<ReportFields>({ symptom: "", expected: "", actual: "" });
  const [editedText, setEditedText] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState(pageCopy.drafting);
  useEffect(
    () =>
      setCreatedAt(
        new Intl.DateTimeFormat("ko-KR", {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        }).format(DateTime.toEpochMillis(DateTime.nowUnsafe())),
      ),
    [],
  );
  const [evidence, setEvidence] = useState<EvidenceState>(EvidenceState.none());
  const [evidenceRetry, setEvidenceRetry] = useState(0);
  const [status, setStatus] = useState(pageCopy.status.noSession);
  const [analysisSession, setAnalysisSession] = useState<{
    projectId: string;
    reportSessionId: string;
  } | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisState>(DiagnosisState.idle());
  const [sessionRetry, setSessionRetry] = useState(0);
  const [sessionFailed, setSessionFailed] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("project");
    const sourceSessionId = params.get("session");
    if (!isTruthy(projectId) || !isTruthy(sourceSessionId)) return;
    setSessionFailed(false);
    const task = Effect.runFork(
      openReportSession({ projectId, sourceSessionId }).pipe(
        Effect.match({
          onSuccess: ({ reportSessionId }) => setAnalysisSession({ projectId, reportSessionId }),
          onFailure: () => {
            setSessionFailed(true);
            setStatus(problemText(pageCopy.sessionFailed));
          },
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(task));
    };
  }, [sessionRetry]);
  const bundle = EvidenceState.$is("collected")(evidence) ? evidence.bundle : null;
  const generatedText = reportText({
    fields,
    createdAt,
    evidence: draftEvidence(evidence),
    diagnosis: diagnosisText(diagnosis),
  });
  const text = editedText ?? generatedText;

  // The whole bundle is collected on open; the user reviews it instead of picking items.
  useEffect(() => {
    const source = reportSource();
    if (source === null) return;
    setEvidence(EvidenceState.loading());
    setStatus(pageCopy.status.collecting);
    const task = Effect.runFork(
      readReportEvidence(source).pipe(
        Effect.match({
          onSuccess: (collected) => {
            setEvidence(EvidenceState.collected({ bundle: collected }));
            setStatus(pageCopy.status.collected);
          },
          onFailure: () => {
            setEvidence(EvidenceState.failed());
            setStatus(problemText(pageCopy.evidenceFailed));
          },
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(task));
    };
  }, [evidenceRetry]);

  const diagnosisTask = useRef<Fiber.Fiber<void> | null>(null);
  useEffect(
    () => () => {
      if (diagnosisTask.current !== null) Effect.runFork(Fiber.interrupt(diagnosisTask.current));
    },
    [],
  );
  const runDiagnosis = () => {
    if (diagnosisTask.current !== null) Effect.runFork(Fiber.interrupt(diagnosisTask.current));
    setDiagnosis(DiagnosisState.running());
    diagnosisTask.current = Effect.runFork(
      requestDiagnosis({
        sourceSessionId: new URLSearchParams(window.location.search).get("session"),
        symptom: fields.symptom.slice(0, 4_000),
        expected: fields.expected.slice(0, 2_000),
        actual: fields.actual.slice(0, 2_000),
        bundle,
      }).pipe(
        Effect.match({
          onSuccess: (result) =>
            setDiagnosis(DiagnosisState.ready({ diagnosis: result, included: true })),
          onFailure: (error) =>
            setDiagnosis(DiagnosisState.failed({ reason: diagnosisFailure(error) })),
        }),
      ),
    );
  };
  // Built only when used: the bundle can be hundreds of kilobytes.
  const shared = () => shareableText(text, draftEvidence(evidence));
  const copy = () =>
    copyReportText(shared(), (value) => navigator.clipboard.writeText(value)).then((copied) => {
      setStatus(copied ? pageCopy.status.copied : problemText(pageCopy.clipboardFailed));
    });

  const download = () => {
    const url = URL.createObjectURL(new Blob([shared()], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "context-agent-report.txt";
    link.click();
    Effect.runFork(
      Effect.sleep("1 second").pipe(Effect.andThen(Effect.sync(() => URL.revokeObjectURL(url)))),
    );
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 text-foreground">
      <header className="space-y-2">
        <a href="/" className="text-sm text-primary underline">
          {pageCopy.back}
        </a>
        <h1 className="text-2xl font-semibold">{pageCopy.heading}</h1>
        <p className="text-sm text-muted-foreground">{pageCopy.intro}</p>
      </header>
      {analysisSession && (
        <p className="text-sm">
          {pageCopy.sessionOpened}{" "}
          <a
            className="text-primary underline"
            href={`/?project=${encodeURIComponent(analysisSession.projectId)}&session=${encodeURIComponent(analysisSession.reportSessionId)}`}
          >
            {pageCopy.openSession}
          </a>
        </p>
      )}
      {sessionFailed && (
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => setSessionRetry((attempt) => attempt + 1)}
        >
          {pageCopy.retrySession}
        </button>
      )}
      <ReportDraft fields={fields} onChange={setFields} text={text} onTextChange={setEditedText} />
      {editedText !== null && (
        <div className="space-y-1 text-sm">
          <p>{pageCopy.editing}</p>
          <button
            type="button"
            onClick={() => setEditedText(null)}
            className="text-primary underline"
          >
            {pageCopy.regenerate}
          </button>
        </div>
      )}
      <section className="space-y-2" aria-label={pageCopy.diagnosisSection}>
        <h2 className="text-sm font-medium">{pageCopy.diagnosisHeading}</h2>
        <ReportDiagnosisReview state={diagnosis} onRequest={runDiagnosis} onChange={setDiagnosis} />
      </section>
      <section className="space-y-3" aria-label={pageCopy.evidenceSection}>
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
        {EvidenceState.$is("failed")(evidence) && (
          <button
            type="button"
            className="text-sm text-primary underline"
            onClick={() => setEvidenceRetry((attempt) => attempt + 1)}
          >
            {pageCopy.retryEvidence}
          </button>
        )}
        {bundle && <ReportBundlePreview bundle={bundle} />}
      </section>
      <section className="space-y-2" aria-label={pageCopy.shareSection}>
        <p className="text-sm">{pageCopy.shareHint}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border px-3 py-2 text-sm"
          >
            {pageCopy.copy}
          </button>
          <button type="button" onClick={download} className="rounded-md border px-3 py-2 text-sm">
            {pageCopy.download}
          </button>
        </div>
      </section>
      <section className="space-y-2" aria-label={pageCopy.deliverySection}>
        <h2 className="text-sm font-medium">{pageCopy.deliveryHeading}</h2>
        <ReportDelivery text={text} evidence={bundle} />
      </section>
    </main>
  );
}
