import { Schema } from "effect";
import { useEffect, useState } from "react";
import type { ReportEvidence } from "../.server/report-evidence";
import { ReportDraft, reportText, type ReportFields } from "../entry/report/report-draft";
import { copyReportText } from "../entry/report/report-copy";
import {
  ReportEvidenceReview,
  evidenceGaps,
  evidenceItems,
  type ReviewSelection,
} from "../entry/report/report-evidence";

export function meta() {
  return [{ title: "문제 제보 · Context Agent" }];
}

export default function ReportPage() {
  const [fields, setFields] = useState<ReportFields>({ symptom: "", expected: "", actual: "" });
  const [editedText, setEditedText] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState("작성 중");
  useEffect(() => setCreatedAt(new Date().toLocaleString("ko-KR")), []);
  const [evidence, setEvidence] = useState<ReportEvidence | null>(null);
  const [selected, setSelected] = useState<ReviewSelection>({});
  const [status, setStatus] = useState("증거를 불러오지 않아도 제보할 수 있습니다.");
  const [loading, setLoading] = useState(false);
  const [analysisSession, setAnalysisSession] = useState<{
    projectId: string;
    reportSessionId: string;
  } | null>(null);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [sessionFailed, setSessionFailed] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("project");
    const sourceSessionId = params.get("session");
    if (!projectId || !sourceSessionId) return;
    let active = true;
    setSessionFailed(false);
    fetch("/api/reports/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, sourceSessionId }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("report session unavailable");
        return Schema.decodeUnknownSync(Schema.Struct({ reportSessionId: Schema.String }))(
          await response.json(),
        );
      })
      .then(({ reportSessionId }) => {
        if (active) setAnalysisSession({ projectId, reportSessionId });
      })
      .catch(() => {
        if (active) {
          setSessionFailed(true);
          setStatus("분석 세션을 열 수 없습니다. 증상 제보문은 계속 작성·저장할 수 있습니다.");
        }
      });
    return () => {
      active = false;
    };
  }, [sessionRetry]);
  const included = evidenceItems(evidence ?? emptyEvidence).filter((item) =>
    Object.hasOwn(selected, item.id),
  );
  const generatedText = reportText(
    fields,
    createdAt,
    included.map((item) => ({
      label: item.label,
      source: item.source,
      text: selected[item.id] ?? "",
    })),
    evidence ? evidenceGaps(evidence) : ["원본 증거: 조회하지 않았거나 조회 실패 (확인되지 않음)"],
    evidence
      ? { projectId: evidence.session.projectId, sessionId: evidence.session.id }
      : undefined,
  );
  const text = editedText ?? generatedText;

  const loadEvidence = async () => {
    const params = new URLSearchParams(window.location.search);
    const project = params.get("project");
    const session = params.get("session");
    if (!project || !session) {
      setStatus("세션 정보가 없습니다. 증상만 작성해 제보할 수 있습니다.");
      return;
    }
    setLoading(true);
    setStatus("증거를 조회하는 중입니다. 증상 제보는 계속 작성할 수 있습니다.");
    try {
      const query = new URLSearchParams({ project, session });
      const response = await fetch(`/api/reports/evidence?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`조회 실패 (${response.status})`);
      const result: ReportEvidence = await response.json();
      setEvidence(result);
      setSelected({});
      setStatus("증거를 불러왔습니다. 포함할 항목을 직접 선택하세요.");
    } catch {
      setStatus("증거 조회에 실패했습니다. 증상만으로도 제보문을 복사할 수 있습니다.");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    const copied = await copyReportText(text, (value) => navigator.clipboard.writeText(value));
    setStatus(
      copied
        ? "제보문을 복사했습니다. 개발자의 Discord 채널에 직접 붙여넣으세요."
        : "클립보드를 사용할 수 없습니다. 위 제보 문안에서 텍스트를 직접 선택해 복사하세요.",
    );
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "context-agent-report.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 text-foreground">
      <header className="space-y-2">
        <a href="/" className="text-sm text-primary underline">
          ← 앱으로 돌아가기
        </a>
        <h1 className="text-2xl font-semibold">문제 제보</h1>
        <p className="text-sm text-muted-foreground">
          채팅이나 실행이 멈춰도 여기서 증상을 기록할 수 있습니다. 이 화면은 제보를 자동으로
          전송하지 않습니다.
        </p>
      </header>
      {analysisSession && (
        <p className="text-sm">
          별도 분석 세션이 열렸습니다.{" "}
          <a
            className="text-primary underline"
            href={`/?project=${encodeURIComponent(analysisSession.projectId)}&session=${encodeURIComponent(analysisSession.reportSessionId)}`}
          >
            분석 세션 보기
          </a>
        </p>
      )}
      {sessionFailed && (
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => setSessionRetry((attempt) => attempt + 1)}
        >
          분석 세션 다시 열기
        </button>
      )}
      <ReportDraft fields={fields} onChange={setFields} text={text} onTextChange={setEditedText} />
      {editedText !== null && (
        <div className="space-y-1 text-sm">
          <p>
            문안을 직접 편집 중입니다. 위 증상이나 증거를 변경해도 현재 문안에는 자동 반영되지
            않습니다.
          </p>
          <button
            type="button"
            onClick={() => setEditedText(null)}
            className="text-primary underline"
          >
            작성·선택한 항목으로 문안 다시 생성 (직접 편집한 내용 삭제)
          </button>
        </div>
      )}
      <section className="space-y-3" aria-label="증거 수집">
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadEvidence()}
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          최근 증거 불러오기 (선택)
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
        {evidence && (
          <ReportEvidenceReview data={evidence} selected={selected} onChange={setSelected} />
        )}
      </section>
      <section className="space-y-2" aria-label="Discord 수동 게시">
        <p className="text-sm">
          문안을 확인한 후 복사하여 개발자의 Discord에 직접 게시하세요. 자동 전송은 하지 않습니다.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border px-3 py-2 text-sm"
          >
            제보문 복사
          </button>
          <button type="button" onClick={download} className="rounded-md border px-3 py-2 text-sm">
            텍스트 파일 저장
          </button>
        </div>
      </section>
    </main>
  );
}

// A missing session or unavailable API never prevents a symptom-only draft.
const emptyEvidence: ReportEvidence = {
  session: { id: "", projectId: "", title: null },
  runs: { status: "empty", items: [], truncated: false },
  approvals: { status: "empty", items: [], truncated: false },
  transcript: { status: "empty", items: [], truncated: false },
  calls: { status: "empty", items: [], truncated: false },
  trace: { status: "empty", items: [], truncated: false },
};
