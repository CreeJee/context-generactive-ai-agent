import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  return [{ title: t`문제 제보 · Context Agent` }];
}

export default function ReportPage() {
  const { t } = useLingui();
  const [fields, setFields] = useState<ReportFields>({ symptom: "", expected: "", actual: "" });
  const [editedText, setEditedText] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState(
    t({
      message: "작성 중",
      comment: "Shown as the report's creation time until the clock is read",
    }),
  );
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
  const [status, setStatus] = useState(t`세션 없이 열면 증상 설명만으로 제보합니다.`);
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
            setStatus(t`분석 세션을 열 수 없습니다. 증상 제보문은 계속 작성·저장할 수 있습니다.`);
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
    setStatus(t`세션의 증거 묶음을 모으는 중입니다. 증상은 계속 작성할 수 있습니다.`);
    const task = Effect.runFork(
      readReportEvidence(source).pipe(
        Effect.match({
          onSuccess: (collected) => {
            setEvidence(EvidenceState.collected({ bundle: collected }));
            setStatus(t`증거 묶음을 모았습니다. 아래에서 보낼 내용을 확인해 주십시오.`);
          },
          onFailure: () => {
            setEvidence(EvidenceState.failed());
            setStatus(t`증거 묶음을 모으지 못했습니다. 증상만으로도 제보할 수 있습니다.`);
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
      setStatus(
        copied
          ? t`제보문과 증거 묶음을 복사했습니다. 개발자의 Discord 채널에 직접 붙여넣어 주십시오.`
          : t`클립보드를 사용할 수 없습니다. 위 제보 문안에서 텍스트를 직접 선택해 복사해 주십시오.`,
      );
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
          <Trans>← 앱으로 돌아가기</Trans>
        </a>
        <h1 className="text-2xl font-semibold">
          <Trans comment="Heading of the problem report page">문제 제보</Trans>
        </h1>
        <p className="text-sm text-muted-foreground">
          <Trans>
            채팅이나 실행이 멈춰도 여기서 증상을 기록할 수 있습니다. 이 화면은 제보를 자동으로
            전송하지 않습니다. 직접 누를 때만 개발자 Discord 웹훅으로 보냅니다.
          </Trans>
        </p>
      </header>
      {analysisSession && (
        <p className="text-sm">
          <Trans>별도 분석 세션이 열렸습니다.</Trans>{" "}
          <a
            className="text-primary underline"
            href={`/?project=${encodeURIComponent(analysisSession.projectId)}&session=${encodeURIComponent(analysisSession.reportSessionId)}`}
          >
            <Trans comment="Link that opens the separate analysis chat session">
              분석 세션 보기
            </Trans>
          </a>
        </p>
      )}
      {sessionFailed && (
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => setSessionRetry((attempt) => attempt + 1)}
        >
          <Trans>분석 세션 다시 열기</Trans>
        </button>
      )}
      <ReportDraft fields={fields} onChange={setFields} text={text} onTextChange={setEditedText} />
      {editedText !== null && (
        <div className="space-y-1 text-sm">
          <p>
            <Trans>
              문안을 직접 편집 중입니다. 위 증상·진단을 바꾸거나 증거 묶음이 도착해도 현재 문안에는
              자동 반영되지 않습니다.
            </Trans>
          </p>
          <button
            type="button"
            onClick={() => setEditedText(null)}
            className="text-primary underline"
          >
            <Trans>설명·진단·증거 묶음으로 문안 다시 생성 (직접 편집한 내용 삭제)</Trans>
          </button>
        </div>
      )}
      <section
        className="space-y-2"
        aria-label={t({
          message: "AI 진단",
          comment: "Accessible name of the AI diagnosis section",
        })}
      >
        <h2 className="text-sm font-medium">
          <Trans>오류 진단과 제보 초안</Trans>
        </h2>
        <ReportDiagnosisReview state={diagnosis} onRequest={runDiagnosis} onChange={setDiagnosis} />
      </section>
      <section
        className="space-y-3"
        aria-label={t({
          message: "증거 수집",
          comment: "Accessible name of the evidence collection section",
        })}
      >
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
        {EvidenceState.$is("failed")(evidence) && (
          <button
            type="button"
            className="text-sm text-primary underline"
            onClick={() => setEvidenceRetry((attempt) => attempt + 1)}
          >
            <Trans>증거 묶음 다시 모으기</Trans>
          </button>
        )}
        {bundle && <ReportBundlePreview bundle={bundle} />}
      </section>
      <section
        className="space-y-2"
        aria-label={t({
          message: "복사·저장",
          comment: "Accessible name of the section for copying or saving the report",
        })}
      >
        <p className="text-sm">
          <Trans>
            문안과 증거 묶음을 함께 복사하거나 텍스트 파일로 저장해 개발자의 Discord에 직접 게시할
            수 있습니다. 웹훅 전송이 실패해도 이 방법은 항상 쓸 수 있습니다.
          </Trans>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <Trans comment="Button that copies the report and evidence to the clipboard">
              제보문 복사
            </Trans>
          </button>
          <button type="button" onClick={download} className="rounded-md border px-3 py-2 text-sm">
            <Trans comment="Button that saves the report and evidence as a text file">
              텍스트 파일 저장
            </Trans>
          </button>
        </div>
      </section>
      <section
        className="space-y-2"
        aria-label={t({
          message: "Discord 웹훅 전송",
          comment: "Accessible name of the section that sends the report to Discord",
        })}
      >
        <h2 className="text-sm font-medium">
          <Trans>개발자 Discord로 보내기 (선택)</Trans>
        </h2>
        <ReportDelivery text={text} evidence={bundle} />
      </section>
    </main>
  );
}
