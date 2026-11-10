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
import { reportCopy } from "./copy";

const copy = reportCopy.bundle;

const bundleSections = [
  "integrations",
  "loops",
  "boards",
  "defects",
  "timeline",
  "unlinked",
] as const;
export type BundleSection = (typeof bundleSections)[number];

/** What the reader should know is missing from the bundle: failed sources and cut sections. */
export function bundleGaps(bundle: ReportBundle): string[] {
  return bundleSections.flatMap((key) => {
    const part = bundle[key];
    const name = copy.sections[key];
    switch (part.status) {
      case "failed":
        return [copy.gapFailed(name)];
      case "empty":
      case "available":
        return part.truncated ? [copy.gapTruncated(name)] : [];
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
      {value.text === "" ? copy.emptyText : value.text}
      {value.cut && <span className="text-muted-foreground"> {copy.textCut}</span>}
    </pre>
  );
}

function Event({ event }: { event: BundleEvent }) {
  return BundleEvent.match(event, {
    Message: (message) => (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {message.role === "user" ? copy.user : copy.model} · {koreanLocalTime(message.at)}
        </p>
        <Text value={message.text} />
      </div>
    ),
    ToolCall: (call) => (
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">
            call-{call.seq} {call.name ?? copy.noName}
          </span>
          {call.result === null ? (
            <Badge variant="outline">{copy.noResult}</Badge>
          ) : call.result.ok === false ? (
            <Badge variant="destructive">{copy.failed}</Badge>
          ) : (
            <Badge variant="secondary">{copy.done}</Badge>
          )}
        </p>
        <Text value={call.input} />
        {call.result && <Text value={call.result.text} />}
      </div>
    ),
    Approval: (approval) => (
      <p className="text-xs">
        {copy.approval(approval.tool ?? copy.unknownTool, approval.status)}
        {approval.approved === null
          ? ""
          : ` · ${approval.approved ? copy.approved : copy.rejected}`}{" "}
        · {koreanLocalTime(approval.requestedAt)}
      </p>
    ),
    Trace: (trace) => (
      <p className="text-xs">
        Work Trace #{trace.ref}: {trace.status}
        {trace.parentToolSeq === null ? "" : ` ${copy.traceFrom(trace.parentToolSeq)}`}
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
          {failed && <Badge variant="destructive">{copy.hasFailure}</Badge>}
          <Badge variant="outline">{copy.eventCount(run.events.length)}</Badge>
        </>
      }
    >
      {run.error && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive">
            {copy.runError(run.error.code ?? copy.noCode)}
          </p>
          <Text value={run.error.detail} />
        </div>
      )}
      {run.failedSpans.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive">{copy.failedSpans}</p>
          <ul className="space-y-0.5 font-mono text-xs break-all">
            {run.failedSpans.map((span, index) => (
              <li key={index}>{spanLine(span)}</li>
            ))}
          </ul>
        </div>
      )}
      {run.spanTotals.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">{copy.spanTotals}</p>
          <ul className="space-y-0.5 font-mono text-xs break-all">
            {run.spanTotals.map((total) => (
              <li key={total.path.join("\n")}>{spanTotalLine(total)}</li>
            ))}
          </ul>
          {run.spanTotalsCut && (
            <p className="text-xs text-muted-foreground">{copy.spanTotalsCut}</p>
          )}
        </div>
      )}
      {run.eventsCut && <p className="text-xs text-muted-foreground">{copy.eventsCut}</p>}
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
  const failingRuns = Arr.countBy(bundle.timeline.items, runHasFailure);
  return (
    <section className="space-y-2" aria-label={copy.section}>
      <h2 className="text-sm font-medium">{copy.heading}</h2>
      <p className="text-xs text-muted-foreground">{copy.note}</p>
      <p className="text-xs" role="status">
        {copy.summary({
          session: bundle.session.ref,
          runs: bundle.timeline.items.length,
          runCount: bundle.session.runCount,
          failingRuns,
          cutTexts: cutTexts(bundle),
          kilobytes: Math.ceil(size / 1024).toLocaleString("ko-KR"),
        })}
      </p>
      {bundleGaps(bundle).map((gap) => (
        <p className="text-xs text-warning" key={gap}>
          {gap}
        </p>
      ))}
      <Fold title={copy.environment}>
        <ul className="space-y-1 text-xs">
          <li>
            {copy.version} {environment.release} · {environment.platform} · {environment.runtime}
          </li>
          <li>
            {copy.model} {environment.provider ?? copy.notSelected} /{" "}
            {environment.model ?? copy.notSelected}
          </li>
          <li>
            {copy.concurrency} {environment.kanbanConcurrency ?? copy.defaultValue}
          </li>
        </ul>
      </Fold>
      <Fold
        title={copy.integrations}
        badge={
          bundle.defects.items.length > 0 && (
            <Badge variant="destructive">{copy.defectCount(bundle.defects.items.length)}</Badge>
          )
        }
      >
        <ul className="space-y-1 text-xs">
          {bundle.integrations.items.map((item) => (
            <li key={`${item.kind}/${item.scope}/${item.name}`}>
              {item.kind === "mcp" ? "MCP" : copy.agent} {item.name} ({item.scope}): {item.status}
              {item.code === null ? "" : ` · ${item.code}`}
            </li>
          ))}
          {bundle.loops.items.map((item) => (
            <li key={item.loop}>{copy.loop(item.loop, item.health)}</li>
          ))}
          {bundle.defects.items.map((defect) => (
            <li key={`${defect.tag}@${defect.location}`}>
              {copy.defect(defect.tag, defect.location, defect.count)} ·{" "}
              {koreanLocalTime(defect.lastAt)}
            </li>
          ))}
        </ul>
      </Fold>
      {bundle.boards.items.length > 0 && (
        <Fold title={copy.boards(bundle.boards.items.length)}>
          {bundle.boards.items.map((board) => (
            <div key={board.ref} className="space-y-1 text-xs">
              <p className="font-medium">{copy.board(board.ref, board.status, board.health)}</p>
              <ul className="space-y-0.5">
                {board.cards.map((card) => (
                  <li key={card.card}>
                    {copy.card(card.card, card.failureStreak, card.replans)}
                    {card.reason === null ? "" : ` · ${card.reason}`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Fold>
      )}
      <Fold title={copy.timeline(bundle.timeline.items.length)}>
        {bundle.timeline.items.length === 0 && <p className="text-xs">{copy.noRuns}</p>}
        {bundle.timeline.items.toReversed().map((run) => (
          <Run key={run.ref} run={run} />
        ))}
      </Fold>
      {bundle.unlinked.items.length > 0 && (
        <Fold title={copy.unlinked(bundle.unlinked.items.length)}>
          {bundle.unlinked.items.map((event, index) => (
            <Event key={index} event={event} />
          ))}
        </Fold>
      )}
    </section>
  );
});
