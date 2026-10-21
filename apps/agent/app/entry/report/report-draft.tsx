import { Data } from "effect";
import { BundleEvent, runHasFailure, runPlace, type ReportBundle } from "memory-agent/definitions";
import { bundleGaps } from "./report-bundle";
import { diagnosisFailureText, DiagnosisText } from "./report-diagnosis";
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
  none: () => ["첨부된 증거 없음. 위 설명만으로 제보합니다."],
  failed: () => ["증거 묶음을 수집하지 못했습니다. 위 설명만으로 제보합니다."],
  collected: ({ bundle }) => {
    const { environment } = bundle;
    const failing = bundle.timeline.items.filter(runHasFailure).slice(-recentFailures);
    return [
      `전체 내용: 첨부 context-agent-evidence.json (세션 #${bundle.session.ref}, run ${bundle.timeline.items.length}/${bundle.session.runCount}개)`,
      `환경: ${environment.release} · ${environment.platform} · ${environment.runtime} · 모델 ${environment.provider ?? "?"}/${environment.model ?? "?"}`,
      ...failing.map((run) => {
        const calls = run.events.flatMap((event) =>
          BundleEvent.guards.ToolCall(event) && event.result?.ok === false
            ? [`${runPlace(run)}/call-${event.seq} ${event.name ?? "?"}`]
            : [],
        );
        return `- ${runPlace(run)} ${run.status}${run.error === null ? "" : ` (오류 ${run.error.code ?? "코드 없음"})`}${calls.length > 0 ? `; 실패한 도구 ${calls.join(", ")}` : ""}`;
      }),
      ...bundle.defects.items
        .slice(0, recentFailures)
        .map((defect) => `- 결함 ${defect.tag} @ ${defect.location} ×${defect.count}`),
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
    "# Context Agent 문제 제보",
    `작성 시각: ${createdAt}`,
    "",
    "## 사용자 설명 (AI 진단 아님)",
    `증상: ${fields.symptom.trim() || "(작성하지 않음)"}`,
    `기대한 동작: ${fields.expected.trim() || "(작성하지 않음)"}`,
    `실제 동작: ${fields.actual.trim() || "(작성하지 않음)"}`,
    "",
    ...diagnosisLines(diagnosis),
    "",
    "## 증거 묶음 요약",
    ...evidenceLines(evidence),
  ].join("\n");
}

/**
 * Text for copying or saving: the draft followed by the whole bundle, so a pasted report carries
 * the same evidence the webhook attaches.
 */
export function shareableText(text: string, evidence: DraftEvidence): string {
  return DraftEvidence.$match(evidence, {
    none: () => text,
    failed: () => text,
    collected: ({ bundle }) =>
      `${text}\n\n## 증거 묶음 (context-agent-evidence.json)\n${JSON.stringify(bundle, null, 2)}\n`,
  });
}

/** Model output stays apart from the user's text and evidence, with guesses labelled as such. */
const diagnosisLines = DiagnosisText.$match({
  none: () => ["AI 진단: 수행하지 않음"],
  failed: ({ reason }) => [
    `AI 진단: 실패 (${diagnosisFailureText[reason]}). 이 제보는 사용자 설명과 증거 묶음뿐입니다.`,
  ],
  included: ({ diagnosis }) => {
    const { summary, observations, hypotheses } = diagnosis;
    return [
      "## AI 진단 요약 (사용자가 검토함)",
      summary.trim() || "- 없음",
      "",
      "## AI 진단: 관측 (증거 묶음에서 확인)",
      ...(observations.length > 0
        ? observations.map((item) => `- ${item.text} (근거: ${item.evidenceIds.join(", ")})`)
        : ["- 없음"]),
      "",
      "## AI 진단: 가설 (검증되지 않은 추정)",
      ...(hypotheses.length > 0 ? hypotheses.map((item) => `- ${item.text}`) : ["- 없음"]),
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
      <section className="space-y-3" aria-label="문제 설명">
        <label className="block text-sm font-medium" htmlFor="report-symptom">
          어떤 문제가 있었나요?
        </label>
        <textarea
          id="report-symptom"
          className="min-h-28 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.symptom}
          onChange={(event) => onChange({ ...fields, symptom: event.target.value })}
          placeholder="예: 승인 창이 계속 나타나고 채팅을 이어갈 수 없어요."
        />
        <label className="block text-sm font-medium" htmlFor="report-expected">
          기대한 동작 (선택)
        </label>
        <textarea
          id="report-expected"
          className="min-h-16 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.expected}
          onChange={(event) => onChange({ ...fields, expected: event.target.value })}
        />
        <label className="block text-sm font-medium" htmlFor="report-actual">
          실제 동작 (선택)
        </label>
        <textarea
          id="report-actual"
          className="min-h-16 w-full rounded-md border bg-background p-3 text-sm"
          value={fields.actual}
          onChange={(event) => onChange({ ...fields, actual: event.target.value })}
        />
      </section>
      <section className="space-y-2" aria-label="제보 문안">
        <label htmlFor="report-preview" className="block text-sm font-medium">
          최종 제보 문안 — 전송·복사·저장 전에 민감정보를 확인하고 편집하세요
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
