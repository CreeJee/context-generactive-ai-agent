import { Schema } from "effect";
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import type { ReportEvidence, EvidenceSection } from "../../.server/report-evidence";

export interface ReviewItem {
  id: string;
  label: string;
  source: string;
  text: string;
}
export type ReviewSelection = Record<string, string>;

export function evidenceItems(data: ReportEvidence): ReviewItem[] {
  return [
    ...data.runs.items.map((run) => ({
      id: `run:${run.runId}`,
      label: `run ${run.runId}`,
      source: `chat_runs · ${new Date(run.startedAt).toISOString()}`,
      text: `상태: ${run.status}; 종료: ${run.finishedAt ? new Date(run.finishedAt).toISOString() : "미기록"}; 오류: ${run.error ?? "없음"}${run.truncated ? " [truncated]" : ""}`,
    })),
    ...data.approvals.items.map((item, index) => ({
      id: `approval:${index}:${item.runId}`,
      label: `승인 ${item.status}`,
      source: `chat_interrupts · run ${item.runId} · ${new Date(item.requestedAt).toISOString()}`,
      text: `상태: ${item.status}; 응답: ${item.resolvedAt ? new Date(item.resolvedAt).toISOString() : "미기록"}`,
    })),
    ...data.transcript.items.map((item) => ({
      id: `chat:${item.id}`,
      label: `대화 ${item.kind}`,
      source: `nodes/${item.id} · ${item.createdAt} · run ${item.runId ?? "연결 없음"}`,
      text: `${item.text}${item.truncated ? " [truncated]" : ""}`,
    })),
    ...data.calls.items.map((item) => ({
      id: `call:${item.id}`,
      label: `도구 ${item.toolName ?? item.kind} (${item.ok === false ? "실패" : "기록"})`,
      source: `nodes/${item.id} · ${item.createdAt} · run ${item.runId ?? "연결 없음"} · call ${item.toolCallId ?? "연결 없음"}`,
      text: `${item.text}${item.truncated ? " [truncated]" : ""}`,
    })),
    ...data.trace.items.map((item) => ({
      id: `trace:${item.id}`,
      label: `Work Trace ${item.status}`,
      source: `trace/${item.id} · ${new Date(item.updatedAt).toISOString()}`,
      text: `부모 run ${item.parentRunId}, 도구 호출 ${item.parentToolCallId} (작업 locator이며 호출 원문이 아닙니다)`,
    })),
  ];
}

export function evidenceGaps(data: ReportEvidence): string[] {
  const groups: [string, EvidenceSection<unknown>][] = [
    ["run", data.runs],
    ["승인", data.approvals],
    ["대화", data.transcript],
    ["도구 호출", data.calls],
    ["Work Trace", data.trace],
  ];
  return groups.flatMap(([name, group]) => [
    ...(group.status === "failed" ? [`${name}: 조회 실패`] : []),
    ...(group.status === "empty" ? [`${name}: 저장된 자료 없음`] : []),
    ...(group.truncated ? [`${name}: 최근 항목 일부만 수집됨`] : []),
  ]);
}

export function ReportEvidenceReview({
  data,
  selected,
  onChange,
}: {
  data: ReportEvidence;
  selected: ReviewSelection;
  onChange: (next: ReviewSelection) => void;
}) {
  const items = evidenceItems(data);
  const [detail, setDetail] = useState<
    Record<string, { text: string; truncated: boolean } | "loading" | "failed">
  >({});
  const loadDetail = async (itemId: string) => {
    setDetail((current) => ({ ...current, [itemId]: "loading" }));
    try {
      const query = new URLSearchParams({
        project: data.session.projectId,
        session: data.session.id,
        item: itemId,
      });
      const response = await fetch(`/api/reports/evidence?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("detail unavailable");
      const value = Schema.decodeUnknownSync(
        Schema.Struct({
          id: Schema.Literal(itemId),
          text: Schema.String,
          truncated: Schema.Boolean,
        }),
      )(await response.json());
      setDetail((current) => ({
        ...current,
        [itemId]: { text: value.text, truncated: value.truncated },
      }));
    } catch {
      setDetail((current) => ({ ...current, [itemId]: "failed" }));
    }
  };
  return (
    <section className="space-y-3" aria-label="증거 검토">
      <h2 className="text-lg font-semibold">최근 증거 검토</h2>
      <p className="text-sm text-muted-foreground">
        증거는 기본적으로 제보문에 포함되지 않습니다. 원문에 비밀정보가 없는지 확인하고 필요한 것만
        선택하세요. 대화는 저장된 노드의 최근 발췌이며 제공자 원시 응답이 아닙니다.
      </p>
      {evidenceGaps(data).map((gap) => (
        <p className="text-sm text-warning" key={gap}>
          {gap}
        </p>
      ))}
      {items.map((item) => {
        const included = Object.hasOwn(selected, item.id);
        const callId = item.id.startsWith("call:") ? item.id.slice(5) : null;
        const expanded = callId ? detail[callId] : undefined;
        const reviewedText =
          expanded && expanded !== "loading" && expanded !== "failed"
            ? `${expanded.text}${expanded.truncated ? " [truncated: 8,000자 상한]" : ""}`
            : item.text;
        return (
          <div key={item.id} className="space-y-2 rounded-md border p-3">
            <label className="flex items-start gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={included}
                onChange={(event) => {
                  const next = { ...selected };
                  if (event.target.checked) next[item.id] = reviewedText;
                  else delete next[item.id];
                  onChange(next);
                }}
              />
              {item.label}
            </label>
            <p className="break-all text-xs text-muted-foreground">출처: {item.source}</p>
            {callId && (
              <div className="space-y-1 text-xs">
                <button
                  type="button"
                  disabled={expanded === "loading"}
                  className="text-primary underline disabled:opacity-50"
                  onClick={() => void loadDetail(callId)}
                >
                  {expanded === "loading"
                    ? "상세를 조회하는 중"
                    : "도구 호출/결과 상세 확인 (최대 8,000자)"}
                </button>
                {expanded === "failed" && (
                  <p role="status">상세 조회 실패 — 최근 발췌만 확인되었습니다.</p>
                )}
                {expanded && expanded !== "loading" && expanded !== "failed" && (
                  <p role="status">
                    상세 조회됨{expanded.truncated ? " — 8,000자 이후는 확인하지 못했습니다." : ""}{" "}
                    이미 선택한 문안은 자동 변경되지 않습니다. 상세를 포함하려면 선택을 해제한 뒤
                    다시 선택하세요.
                  </p>
                )}
              </div>
            )}
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-left text-sm">
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 transition-transform group-data-[panel-open]:rotate-90"
                />
                {expanded && expanded !== "loading" && expanded !== "failed"
                  ? "조회한 상세 원문 확인"
                  : "최근 발췌 원문 확인"}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {reviewedText}
                </pre>
              </CollapsibleContent>
            </Collapsible>
            {included && (
              <textarea
                aria-label={`${item.label} 제보문에 포함할 내용 편집`}
                className="min-h-24 w-full rounded-md border bg-background p-2 text-xs"
                value={selected[item.id]}
                onChange={(event) => onChange({ ...selected, [item.id]: event.target.value })}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
