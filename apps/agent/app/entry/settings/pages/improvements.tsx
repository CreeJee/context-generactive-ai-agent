import { Match, Option, Schema } from "effect";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import type { ImprovementReport } from "memory-agent";
import { reportedTitle, ScanState, sourceLabels } from "memory-agent/definitions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { api, type ImprovementStatus, refusalOf, ScanCommand } from "../../api";
import { koreanLocalTime } from "../../shared/local-time";
import { PageError, PageHeader, shortPath } from "../shared";
import { problemText } from "../../shared/copy-templates";
import { settingsCopy } from "../copy";

const copy = settingsCopy.improvements;

const queryKey = ["settings", "improvements"];

/** Why a request failed, as the server names it. */
const FailureReason = Schema.Literals(["report"]);

/** One line on where the scan stands; nothing while idle. */
const stateLine = ScanState.match({
  idle: () => null,
  running: ({ repositories, items }) =>
    repositories.total === 0
      ? copy.collecting
      : copy.progress(repositories.done, repositories.total, items.done, items.total),
  failed: ({ reason }) => copy.failures[reason],
  stopped: () => copy.stopped,
});

type ReportedItem = ImprovementReport["items"][number];
const itemRule = (item: ReportedItem) =>
  Match.valueTags(item.interpretation, {
    interpreted: ({ rule }) => copy.rule(rule),
    failed: () => copy.ruleFailed,
  });

/** What a failed request says: this page's own wording, never a browser or transport message. */
const requestFailure = (failure: Error) => {
  const refusal = refusalOf(failure);
  if (refusal?.status === 404) return problemText(copy.unsupported);
  return Option.match(Schema.decodeUnknownOption(FailureReason)(refusal?.reason), {
    onNone: () => copy.requestFailed,
    onSome: (reason) => copy.failures[reason],
  });
};

function Report({ report }: { report: ImprovementReport }) {
  const [copied, setCopied] = useState(false);
  const name = report.repository.split(/[/\\]/u).at(-1) ?? report.repository;
  return (
    <section className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{name}</h4>
        <Badge variant="secondary">{copy.itemCount(report.items.length)}</Badge>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {shortPath(report.repository)}
        </span>
      </div>
      {report.items.length === 0 ? (
        <FieldDescription>{copy.noItems}</FieldDescription>
      ) : (
        <ol className="flex flex-col gap-1 text-xs">
          {report.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <Badge variant="outline">{sourceLabels[item.source]}</Badge>
                <span className="min-w-0 flex-1 truncate">{reportedTitle(item)}</span>
                <span className="shrink-0 text-muted-foreground">
                  {copy.occurrences(item.count)}
                </span>
              </div>
              <span className="pl-1 text-muted-foreground">{itemRule(item)}</span>
            </li>
          ))}
        </ol>
      )}
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
          <ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
          {copy.showDocument}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {shortPath(report.file)}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(report.markdown).then(() => setCopied(true))
              }
            >
              {copied ? copy.copied : copy.copyDocument}
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {report.markdown}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * What to improve in the repositories behind the open projects. The app only records it: each
 * report is a document the user hands to an agent or tool of their choice.
 */
export function ImprovementSettings() {
  const cache = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, error: queryError } = useQuery({
    queryKey,
    queryFn: api.improvements,
    // Follow a running scan; otherwise the page only changes when the user acts.
    refetchInterval: (query) =>
      query.state.data !== undefined && ScanState.guards.running(query.state.data.state)
        ? 2000
        : false,
    retry: false,
  });
  const command = useMutation({
    mutationFn: api.improvementScan,
    onSuccess: ({ state }) => {
      setError(null);
      cache.setQueryData<ImprovementStatus>(queryKey, (current) =>
        current === undefined ? current : { ...current, state },
      );
    },
    onError: (failure) => setError(requestFailure(failure)),
  });
  const latest = data?.scan ?? null;
  const running = data !== undefined && ScanState.guards.running(data.state);
  const line = data === undefined ? null : stateLine(data.state);
  return (
    <FieldGroup>
      <PageHeader
        title={settingsCopy.titles.improvements}
        description={copy.description}
        action={
          running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={command.isPending}
              onClick={() => command.mutate(ScanCommand.stop())}
            >
              {copy.stop}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={command.isPending || data === undefined}
              onClick={() => command.mutate(ScanCommand.start())}
            >
              {latest === null ? copy.find : copy.findAgain}
            </Button>
          )
        }
      />
      {line !== null && <FieldDescription role="status">{line}</FieldDescription>}
      <PageError error={error ?? (queryError === null ? null : requestFailure(queryError))} />
      {data === undefined ? (
        queryError === null && <FieldDescription role="status">{copy.loading}</FieldDescription>
      ) : latest === null ? (
        <FieldDescription>{copy.neverScanned}</FieldDescription>
      ) : (
        <>
          <FieldDescription>{copy.foundAt(koreanLocalTime(latest.generatedAt))}</FieldDescription>
          {latest.reports.length === 0 ? (
            <FieldDescription>{copy.noRepositories}</FieldDescription>
          ) : (
            latest.reports.map((report) => <Report key={report.repository} report={report} />)
          )}
        </>
      )}
    </FieldGroup>
  );
}
