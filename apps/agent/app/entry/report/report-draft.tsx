export interface ReportFields {
  symptom: string;
  expected: string;
  actual: string;
}

export function reportText(
  fields: ReportFields,
  createdAt: string,
  evidence: readonly { label: string; source: string; text: string }[] = [],
  unavailable: readonly string[] = [],
  origin?: { projectId: string; sessionId: string },
): string {
  return [
    "# Context Agent 문제 제보",
    `작성 시각: ${createdAt}`,
    ...(origin ? [`증거 출처: 프로젝트 ${origin.projectId} / 원본 세션 ${origin.sessionId}`] : []),
    "",
    "## 사용자 설명 (AI 진단 아님)",
    `증상: ${fields.symptom.trim() || "(작성하지 않음)"}`,
    `기대한 동작: ${fields.expected.trim() || "(작성하지 않음)"}`,
    `실제 동작: ${fields.actual.trim() || "(작성하지 않음)"}`,
    "",
    "## 관측된 증거 (선택한 항목만)",
    evidence.length
      ? evidence.map((item) => `[${item.label} | ${item.source}]\n${item.text}`).join("\n\n")
      : "첨부된 증거 없음. 아래 설명만으로 제보할 수 있습니다.",
    ...(unavailable.length ? ["", "## 수집하지 못한 정보", ...unavailable] : []),
    "",
    "AI 진단: 수행하지 않음 (위 증거는 AI의 추정이 아닙니다.)",
  ].join("\n");
}

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
