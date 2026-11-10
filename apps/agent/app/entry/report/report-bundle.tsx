import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRightIcon } from "lucide-react";
import {
  BundleEvent,
  runHasFailure,
  runPlace,
  spanLine,
  spanTotalLine,
  type BundleRun,
  type BundleText,
  type ReportBundle,
} from "memory-agent/definitions";
import { memo, type ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { koreanLocalTime } from "../shared/local-time";
import { Array as Arr } from "effect";

const bundleSections = [
  "integrations",
  "loops",
  "boards",
  "defects",
  "timeline",
  "unlinked",
] as const;
export type BundleSection = (typeof bundleSections)[number];

/** Section names, as the gap lines name the part of the bundle that failed or was cut. */
const sectionNames = {
  integrations: msg`MCP·외부 에이전트`,
  loops: msg`백그라운드 루프`,
  boards: msg`칸반 보드`,
  defects: msg`최근 결함`,
  timeline: msg`세션 타임라인`,
  unlinked: msg`run 없는 항목`,
} satisfies Record<BundleSection, MessageDescriptor>;

/** What the reader should know is missing from the bundle: failed sources and cut sections. */
export function bundleGaps(bundle: ReportBundle): string[] {
  return bundleSections.flatMap((key) => {
    const part = bundle[key];
    const section = i18n._(sectionNames[key]);
    switch (part.status) {
      case "failed":
        return [t`${section}: 수집 실패`];
      case "empty":
      case "available":
        return part.truncated ? [t`${section}: 오래된 항목은 상한 때문에 빠졌음`] : [];
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
  return Arr.countBy(
    [
      ...bundle.timeline.items.flatMap((run) => [
        ...(run.error === null ? [] : [run.error.detail]),
        ...run.events.flatMap(texts),
      ]),
      ...bundle.unlinked.items.flatMap(texts),
    ],
    (text) => text.cut,
  );
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
      {value.text === "" ? (
        <Trans comment="Shown in place of an empty text in the evidence preview">(비어 있음)</Trans>
      ) : (
        value.text
      )}
      {value.cut && (
        <span className="text-muted-foreground">
          {" "}
          <Trans comment="Marks a text that was cut at the size limit">[상한에서 잘림]</Trans>
        </span>
      )}
    </pre>
  );
}

function Event({ event }: { event: BundleEvent }) {
  const { t } = useLingui();
  return BundleEvent.match(event, {
    Message: (message) => (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {message.role === "user" ? (
            <Trans comment="Author of a chat message in the evidence preview">사용자</Trans>
          ) : (
            <Trans comment="Author of a chat message in the evidence preview: the AI model">
              모델
            </Trans>
          )}{" "}
          · {koreanLocalTime(message.at)}
        </p>
        <Text value={message.text} />
      </div>
    ),
    ToolCall: (call) => (
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">
            call-{call.seq}{" "}
            {call.name ?? (
              <Trans comment="Shown for a tool call whose tool name was not recorded">
                (이름 없음)
              </Trans>
            )}
          </span>
          {call.result === null ? (
            <Badge variant="outline">
              <Trans comment="Badge on a tool call that has no result yet">결과 없음</Trans>
            </Badge>
          ) : call.result.ok === false ? (
            <Badge variant="destructive">
              <Trans comment="Badge on a tool call that failed">실패</Trans>
            </Badge>
          ) : (
            <Badge variant="secondary">
              <Trans comment="Badge on a tool call that finished">완료</Trans>
            </Badge>
          )}
        </p>
        <Text value={call.input} />
        {call.result && <Text value={call.result.text} />}
      </div>
    ),
    Approval: (approval) => {
      const tool =
        approval.tool ??
        t({ message: "(도구 미상)", comment: "Shown for an approval request with no tool name" });
      const { status } = approval;
      return (
        <p className="text-xs">
          <Trans comment="status: the approval request's status code">
            승인 요청 {tool}: {status}
          </Trans>
          {approval.approved === null
            ? ""
            : ` · ${
                approval.approved
                  ? t({ message: "승인", comment: "The user approved the tool call" })
                  : t({ message: "거부", comment: "The user rejected the tool call" })
              }`}{" "}
          · {koreanLocalTime(approval.requestedAt)}
        </p>
      );
    },
    Trace: (trace) => (
      <p className="text-xs">
        Work Trace #{trace.ref}: {trace.status}
        {trace.parentToolSeq === null
          ? ""
          : ` ${t({
              message: `(call-${ph({ seq: trace.parentToolSeq })}에서 시작)`,
              comment: "seq: number of the tool call that started this work trace",
            })}`}
      </p>
    ),
  });
}

function Run({ run }: { run: BundleRun }) {
  const { t } = useLingui();
  const failed = runHasFailure(run);
  const eventCount = run.events.length;
  return (
    <Fold
      title={`${runPlace(run)} · ${run.status} · ${koreanLocalTime(run.startedAt)}`}
      badge={
        <>
          {failed && (
            <Badge variant="destructive">
              <Trans comment="Badge on a run that has a failure">실패 포함</Trans>
            </Badge>
          )}
          <Badge variant="outline">
            <Trans comment="Badge with the number of events in a run">{eventCount}개</Trans>
          </Badge>
        </>
      }
    >
      {run.error && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive">
            <Trans comment="code: the run's error code">
              run 오류{" "}
              {ph({
                code:
                  run.error.code ??
                  t({ message: "(코드 없음)", comment: "Shown for a run error without a code" }),
              })}
            </Trans>
          </p>
          <Text value={run.error.detail} />
        </div>
      )}
      {run.failedSpans.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive">
            <Trans comment="Heading above the failed tracing spans of a run">실패한 span</Trans>
          </p>
          <ul className="space-y-0.5 font-mono text-xs break-all">
            {run.failedSpans.map((span, index) => (
              <li key={index}>{spanLine(span)}</li>
            ))}
          </ul>
        </div>
      )}
      {run.spanTotals.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">
            <Trans>시간을 쓴 곳 (span 합계)</Trans>
          </p>
          <ul className="space-y-0.5 font-mono text-xs break-all">
            {run.spanTotals.map((total) => (
              <li key={total.path.join("\n")}>{spanTotalLine(total)}</li>
            ))}
          </ul>
          {run.spanTotalsCut && (
            <p className="text-xs text-muted-foreground">
              <Trans>짧게 걸린 span 경로는 빠졌습니다.</Trans>
            </p>
          )}
        </div>
      )}
      {run.eventsCut && (
        <p className="text-xs text-muted-foreground">
          <Trans>앞부분 이벤트는 빠졌습니다.</Trans>
        </p>
      )}
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
  const { t } = useLingui();
  const { environment } = bundle;
  const notSelected = t({
    message: "(선택 없음)",
    comment: "Shown when no model provider or model was selected",
  });
  const size = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
  const failingRuns = Arr.countBy(bundle.timeline.items, runHasFailure);
  return (
    <section
      className="space-y-2"
      aria-label={t({
        message: "보낼 증거 묶음",
        comment: "Accessible name of the evidence preview section",
      })}
    >
      <h2 className="text-sm font-medium">
        <Trans>보낼 증거 묶음 (읽기 전용)</Trans>
      </h2>
      <p className="text-xs text-muted-foreground">
        <Trans>
          아래 내용 전체가 제보에 JSON 첨부 파일로 붙습니다. 비밀정보 탐지기로 가렸지만 놓친 값이
          있을 수 있으니 보내기 전에 펼쳐서 확인해 주십시오.
        </Trans>
      </p>
      <p className="text-xs" role="status">
        <Trans comment="session: session ref; runs/runCount: runs in the bundle / runs in the session">
          세션 #{ph({ session: bundle.session.ref })} · run{" "}
          {ph({ runs: bundle.timeline.items.length })}/{ph({ runCount: bundle.session.runCount })}개
          · 실패 포함 run {failingRuns}개 · 잘린 원문 {ph({ cutTexts: cutTexts(bundle) })}개 · 약{" "}
          {ph({ kilobytes: Math.ceil(size / 1024).toLocaleString("ko-KR") })}KB
        </Trans>
      </p>
      {bundleGaps(bundle).map((gap, index) => (
        <p className="text-xs text-warning" key={index}>
          {gap}
        </p>
      ))}
      <Fold
        title={t({ message: "환경", comment: "Panel title for the app's runtime environment" })}
      >
        <ul className="space-y-1 text-xs">
          <li>
            <Trans comment="Label before the app release version">버전</Trans> {environment.release}{" "}
            · {environment.platform} · {environment.runtime}
          </li>
          <li>
            <Trans comment="Label before the selected provider and AI model">모델</Trans>{" "}
            {environment.provider ?? notSelected} / {environment.model ?? notSelected}
          </li>
          <li>
            <Trans comment="Label before how many kanban cards run at once">칸반 동시 실행</Trans>{" "}
            {environment.kanbanConcurrency ?? (
              <Trans comment="The setting is left at its default value">기본값</Trans>
            )}
          </li>
        </ul>
      </Fold>
      <Fold
        title={t({
          message: "연동·루프·결함",
          comment: "Panel title: integrations, background loops and defects",
        })}
        badge={
          bundle.defects.items.length > 0 && (
            <Badge variant="destructive">
              <Trans comment="Badge with the number of recent defects">
                결함 {ph({ count: bundle.defects.items.length })}
              </Trans>
            </Badge>
          )
        }
      >
        <ul className="space-y-1 text-xs">
          {bundle.integrations.items.map((item) => (
            <li key={`${item.kind}/${item.scope}/${item.name}`}>
              {item.kind === "mcp"
                ? "MCP"
                : t({
                    message: "에이전트",
                    comment: "Kind of an integration: an external agent",
                  })}{" "}
              {item.name} ({item.scope}): {item.status}
              {item.code === null ? "" : ` · ${item.code}`}
            </li>
          ))}
          {bundle.loops.items.map((item) => (
            <li key={item.loop}>
              <Trans comment="loop: background loop name; health: its health status">
                루프 {ph({ loop: item.loop })}: {ph({ health: item.health })}
              </Trans>
            </li>
          ))}
          {bundle.defects.items.map((defect) => (
            <li key={`${defect.tag}@${defect.location}`}>
              <Trans comment="tag: defect kind; location: where it happened; count: occurrences">
                결함 {ph({ tag: defect.tag })} @ {ph({ location: defect.location })} ×
                {ph({ count: defect.count })}
              </Trans>{" "}
              · {koreanLocalTime(defect.lastAt)}
            </li>
          ))}
        </ul>
      </Fold>
      {bundle.boards.items.length > 0 && (
        <Fold
          title={t({
            message: `칸반 보드 (${ph({ count: bundle.boards.items.length })})`,
            comment: "Panel title with the number of kanban boards",
          })}
        >
          {bundle.boards.items.map((board) => (
            <div key={board.ref} className="space-y-1 text-xs">
              <p className="font-medium">
                <Trans comment="ref: board ref; status: board status; health: its loop's health">
                  보드 #{ph({ ref: board.ref })} · {ph({ status: board.status })} · 루프{" "}
                  {ph({ health: board.health })}
                </Trans>
              </p>
              <ul className="space-y-0.5">
                {board.cards.map((card) => (
                  <li key={card.card}>
                    <Trans comment="card: card ref; failureStreak: failures in a row; replans: Plan rewrites">
                      {ph({ card: card.card })}: 실패 {ph({ failureStreak: card.failureStreak })} ·
                      Plan 재작성 {ph({ replans: card.replans })}
                    </Trans>
                    {card.reason === null ? "" : ` · ${card.reason}`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Fold>
      )}
      <Fold
        title={t({
          message: `세션 타임라인 (run ${ph({ count: bundle.timeline.items.length })})`,
          comment: "Panel title with the number of runs in the session timeline",
        })}
      >
        {bundle.timeline.items.length === 0 && (
          <p className="text-xs">
            <Trans>기록된 run이 없습니다.</Trans>
          </p>
        )}
        {bundle.timeline.items.toReversed().map((run) => (
          <Run key={run.ref} run={run} />
        ))}
      </Fold>
      {bundle.unlinked.items.length > 0 && (
        <Fold
          title={t({
            message: `run 없는 항목 (${ph({ count: bundle.unlinked.items.length })})`,
            comment: "Panel title with the number of events not linked to any run",
          })}
        >
          {bundle.unlinked.items.map((event, index) => (
            <Event key={index} event={event} />
          ))}
        </Fold>
      )}
    </section>
  );
});
