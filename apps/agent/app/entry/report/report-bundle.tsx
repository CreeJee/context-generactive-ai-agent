import { ChevronRightIcon } from "lucide-react";
import {
  BundleEvent,
  runHasFailure,
  runPlace,
  type BundleRun,
  type BundleText,
  type ReportBundle,
} from "memory-agent/definitions";
import { memo, type ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { koreanLocalTime } from "../shared/local-time";

const sectionNames = [
  ["integrations", "MCP·외부 에이전트"],
  ["loops", "백그라운드 루프"],
  ["boards", "칸반 보드"],
  ["defects", "최근 결함"],
  ["timeline", "세션 타임라인"],
  ["unlinked", "run 없는 항목"],
] as const;

/** What the reader should know is missing from the bundle: failed sources and cut sections. */
export function bundleGaps(bundle: ReportBundle): string[] {
  return sectionNames.flatMap(([key, name]) => {
    const part = bundle[key];
    switch (part.status) {
      case "failed":
        return [`${name}: 수집 실패`];
      case "empty":
      case "available":
        return part.truncated ? [`${name}: 오래된 항목은 상한 때문에 빠졌음`] : [];
    }
  });
}

/** How many texts in the bundle were cut to their limit. */
export function cutTexts(bundle: ReportBundle): number {
  const texts = (event: BundleEvent): BundleText[] =>
    BundleEvent.match(event, {
      Message: ({ text }) => [text],
      ToolCall: ({ input, result }) => (result === null ? [input] : [input, result.text]),
      Approval: () => [],
      Trace: () => [],
    });
  return [
    ...bundle.timeline.items.flatMap((run) => [
      ...(run.error === null ? [] : [run.error.detail]),
      ...run.events.flatMap(texts),
    ]),
    ...bundle.unlinked.items.flatMap(texts),
  ].filter((text) => text.cut).length;
}

function Fold({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  // Closed panels are not mounted, so a bundle of hundreds of runs renders only what is open.
  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
        <span className="font-medium">{title}</span>
        {badge}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Text({ value }: { value: BundleText }) {
  return (
    <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap break-all">
      {value.text === "" ? "(비어 있음)" : value.text}
      {value.cut && <span className="text-muted-foreground"> [상한에서 잘림]</span>}
    </pre>
  );
}

function Event({ event }: { event: BundleEvent }) {
  return BundleEvent.match(event, {
    Message: (message) => (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {message.role === "user" ? "사용자" : "모델"} · {koreanLocalTime(message.at)}
        </p>
        <Text value={message.text} />
      </div>
    ),
    ToolCall: (call) => (
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">
            call-{call.seq} {call.name ?? "(이름 없음)"}
          </span>
          {call.result === null ? (
            <Badge variant="outline">결과 없음</Badge>
          ) : call.result.ok === false ? (
            <Badge variant="destructive">실패</Badge>
          ) : (
            <Badge variant="secondary">완료</Badge>
          )}
        </p>
        <Text value={call.input} />
        {call.result && <Text value={call.result.text} />}
      </div>
    ),
    Approval: (approval) => (
      <p className="text-xs">
        승인 요청 {approval.tool ?? "(도구 미상)"}: {approval.status}
        {approval.approved === null ? "" : approval.approved ? " · 승인" : " · 거부"} ·{" "}
        {koreanLocalTime(approval.requestedAt)}
      </p>
    ),
    Trace: (trace) => (
      <p className="text-xs">
        Work Trace #{trace.ref}: {trace.status}
        {trace.parentToolSeq === null ? "" : ` (call-${trace.parentToolSeq}에서 시작)`}
      </p>
    ),
  });
}

function Run({ run }: { run: BundleRun }) {
  const failed = runHasFailure(run);
  return (
    <Fold
      title={`${runPlace(run)} · ${run.status} · ${koreanLocalTime(run.startedAt)}`}
      badge={
        <>
          {failed && <Badge variant="destructive">실패 포함</Badge>}
          <Badge variant="outline">{run.events.length}개</Badge>
        </>
      }
    >
      {run.error && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive">
            run 오류 {run.error.code ?? "(코드 없음)"}
          </p>
          <Text value={run.error.detail} />
        </div>
      )}
      {run.eventsCut && <p className="text-xs text-muted-foreground">앞부분 이벤트는 빠졌어요.</p>}
      {run.events.map((event, index) => (
        <Event key={index} event={event} />
      ))}
    </Fold>
  );
}

/**
 * Read-only preview of everything the report will carry; the user does not pick items. Memoized:
 * the page re-renders on every keystroke of the description.
 */
export const ReportBundlePreview = memo(function ReportBundlePreview({
  bundle,
}: {
  bundle: ReportBundle;
}) {
  const { environment } = bundle;
  const size = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
  const failingRuns = bundle.timeline.items.filter(runHasFailure).length;
  return (
    <section className="space-y-2" aria-label="보낼 증거 묶음">
      <h2 className="text-sm font-medium">보낼 증거 묶음 (읽기 전용)</h2>
      <p className="text-xs text-muted-foreground">
        아래 내용 전체가 제보에 JSON 첨부 파일로 붙습니다. 비밀정보 탐지기로 가렸지만 놓친 값이 있을
        수 있으니 보내기 전에 펼쳐서 확인하세요.
      </p>
      <p className="text-xs" role="status">
        세션 #{bundle.session.ref} · run {bundle.timeline.items.length}/{bundle.session.runCount}
        개 · 실패 포함 run {failingRuns}개 · 잘린 원문 {cutTexts(bundle)}개 · 약{" "}
        {Math.ceil(size / 1024).toLocaleString("ko-KR")}KB
      </p>
      {bundleGaps(bundle).map((gap) => (
        <p className="text-xs text-warning" key={gap}>
          {gap}
        </p>
      ))}
      <Fold title="환경">
        <ul className="space-y-1 text-xs">
          <li>
            버전 {environment.release} · {environment.platform} · {environment.runtime}
          </li>
          <li>
            모델 {environment.provider ?? "(선택 없음)"} / {environment.model ?? "(선택 없음)"}
          </li>
          <li>칸반 동시 실행 {environment.kanbanConcurrency ?? "기본값"}</li>
        </ul>
      </Fold>
      <Fold
        title="연동·루프·결함"
        badge={
          bundle.defects.items.length > 0 && (
            <Badge variant="destructive">결함 {bundle.defects.items.length}</Badge>
          )
        }
      >
        <ul className="space-y-1 text-xs">
          {bundle.integrations.items.map((item) => (
            <li key={`${item.kind}/${item.scope}/${item.name}`}>
              {item.kind === "mcp" ? "MCP" : "에이전트"} {item.name} ({item.scope}): {item.status}
              {item.code === null ? "" : ` · ${item.code}`}
            </li>
          ))}
          {bundle.loops.items.map((item) => (
            <li key={item.loop}>
              루프 {item.loop}: {item.health}
            </li>
          ))}
          {bundle.defects.items.map((defect) => (
            <li key={`${defect.tag}@${defect.location}`}>
              결함 {defect.tag} @ {defect.location} ×{defect.count} ·{" "}
              {koreanLocalTime(defect.lastAt)}
            </li>
          ))}
        </ul>
      </Fold>
      {bundle.boards.items.length > 0 && (
        <Fold title={`칸반 보드 (${bundle.boards.items.length})`}>
          {bundle.boards.items.map((board) => (
            <div key={board.ref} className="space-y-1 text-xs">
              <p className="font-medium">
                보드 #{board.ref} · {board.status} · 루프 {board.health}
              </p>
              <ul className="space-y-0.5">
                {board.cards.map((card) => (
                  <li key={card.card}>
                    {card.card}: 실패 {card.failureStreak} · 재계획 {card.replans}
                    {card.reason === null ? "" : ` · ${card.reason}`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Fold>
      )}
      <Fold title={`세션 타임라인 (run ${bundle.timeline.items.length})`}>
        {bundle.timeline.items.length === 0 && <p className="text-xs">기록된 run이 없어요.</p>}
        {bundle.timeline.items.toReversed().map((run) => (
          <Run key={run.ref} run={run} />
        ))}
      </Fold>
      {bundle.unlinked.items.length > 0 && (
        <Fold title={`run 없는 항목 (${bundle.unlinked.items.length})`}>
          {bundle.unlinked.items.map((event, index) => (
            <Event key={index} event={event} />
          ))}
        </Fold>
      )}
    </section>
  );
});
