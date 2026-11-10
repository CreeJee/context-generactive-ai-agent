import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Match, Option, Schema } from "effect";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import type { ImprovementReport } from "memory-agent";
import { reportedTitle, type ScanFailure, ScanState, sourceLabels } from "memory-agent/definitions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { api, refusalOf, ScanCommand } from "../../api";
import { koreanLocalTime } from "../../shared/local-time";
import { globalQueries, useImprovementsQuery } from "../../queries/global";
import { PageError, PageHeader, pageTitles, shortPath, useClipboardCopy } from "../shared";

/** Why a request failed, as the server names it. */
const FailureReason = Schema.Literals(["report"]);

const failures = {
  storage: msg`프로젝트 사용 기록을 읽지 못했습니다.`,
  report: msg`개선 문서를 쓰거나 읽지 못했습니다.`,
  embedding: msg`임베딩 모델로 비슷한 정정을 묶지 못했습니다. 임베딩 설정을 확인해 주십시오.`,
  model_unavailable: msg`개선 항목을 해석할 모델이 없습니다. 채팅에서 모델을 고르고 로그인한 뒤 다시 시도해 주십시오.`,
  model_unreachable: msg`모델 서버가 응답하지 않아 찾기를 멈췄습니다. 모델 서버 연결을 확인한 뒤 다시 시도해 주십시오.`,
  internal: msg`개선 항목을 찾는 중 오류가 났습니다. 다시 시도해 주십시오.`,
} satisfies Record<ScanFailure, MessageDescriptor>;

/** One line on where the scan stands; nothing while idle. */
const stateLine = ScanState.match({
  idle: () => null,
  running: ({ repositories, items }) =>
    repositories.total === 0
      ? t`사용 기록에서 신호를 모으는 중입니다.`
      : t`찾는 중입니다. 저장소 ${ph({ repositoriesDone: repositories.done })}/${ph({ repositoriesTotal: repositories.total })} · 해석한 항목 ${ph({ itemsDone: items.done })}/${ph({ itemsTotal: items.total })}`,
  failed: ({ reason }) => i18n._(failures[reason]),
  stopped: () => t`찾기를 중지했습니다. 이전 결과는 그대로입니다.`,
});

type ReportedItem = ImprovementReport["items"][number];
const itemRule = (item: ReportedItem) =>
  Match.valueTags(item.interpretation, {
    interpreted: ({ rule }) => t`지침: ${rule}`,
    failed: () => t`모델이 해석하지 못했습니다. 문서의 근거를 직접 확인해 주십시오.`,
  });

/** What a failed request says: this page's own wording, never a browser or transport message. */
const requestFailure = (failure: Error) => {
  const refusal = refusalOf(failure);
  if (refusal?.status === 404)
    return t`실행 중인 서버가 프로젝트 개선을 지원하지 않습니다. 앱 서버를 재시작한 뒤 다시 시도해 주십시오.`;
  return Option.match(Schema.decodeUnknownOption(FailureReason)(refusal?.reason), {
    onNone: () => t`요청을 처리하지 못했습니다.`,
    onSome: (reason) => i18n._(failures[reason]),
  });
};

function Report({ report }: { report: ImprovementReport }) {
  const { outcome, copy } = useClipboardCopy();
  const name = report.repository.split(/[/\\]/u).at(-1) ?? report.repository;
  const itemCount = report.items.length;
  return (
    <section className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{name}</h4>
        <Badge variant="secondary">
          <Trans comment="Badge next to a repository name; {itemCount} is how many items its report lists">
            {itemCount}개 항목
          </Trans>
        </Badge>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {shortPath(report.repository)}
        </span>
      </div>
      {report.items.length === 0 ? (
        <FieldDescription>
          <Trans>반복된 정정이나 실패가 없어 고칠 항목이 없습니다.</Trans>
        </FieldDescription>
      ) : (
        <ol className="flex flex-col gap-1 text-xs">
          {report.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <Badge variant="outline">{sourceLabels[item.source]}</Badge>
                <span className="min-w-0 flex-1 truncate">{reportedTitle(item)}</span>
                <span className="shrink-0 text-muted-foreground">
                  <Trans comment="How many times a correction or failure repeated">
                    {ph({ count: item.count })}회
                  </Trans>
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
          <Trans>작업 명세 문서 보기</Trans>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {shortPath(report.file)}
            </span>
            <Button size="sm" variant="outline" onClick={() => copy(report.markdown)}>
              {outcome === "copied" ? (
                <Trans comment="Copy button label right after it copied the document">
                  복사했습니다
                </Trans>
              ) : (
                <Trans comment="Button that copies the improvement document">문서 복사</Trans>
              )}
            </Button>
          </div>
          {outcome === "failed" && (
            <p role="alert" className="text-xs text-destructive">
              <Trans>
                클립보드를 사용할 수 없습니다. 아래 문서에서 텍스트를 직접 선택해 복사해 주십시오.
              </Trans>
            </p>
          )}
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
  const { t } = useLingui();
  const cache = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useImprovementsQuery();
  const command = useMutation({
    mutationFn: api.improvementScan,
    onSuccess: ({ state }) => {
      setError(null);
      cache.setQueryData(globalQueries.improvements().queryKey, (current) =>
        current === undefined ? current : { ...current, state },
      );
    },
    onError: (failure) => setError(requestFailure(failure)),
  });
  const latest = data.scan;
  const running = ScanState.guards.running(data.state);
  const line = stateLine(data.state);
  return (
    <FieldGroup>
      <PageHeader
        title={t(pageTitles.improvements)}
        description={
          <Trans>
            열린 프로젝트의 최근 90일 사용 기록에서 반복된 정정과 실패를 찾아 저장소마다 고칠 항목과
            작업 명세를 문서로 남깁니다. 코드와 에이전트 지침을 함께 고치는 명세입니다. 앱은
            저장소를 직접 바꾸지 않습니다.
          </Trans>
        }
        action={
          running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={command.isPending}
              onClick={() => command.mutate(ScanCommand.stop())}
            >
              <Trans comment="Button that stops a running improvement scan">중지</Trans>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={command.isPending}
              onClick={() => command.mutate(ScanCommand.start())}
            >
              {latest === null ? (
                <Trans>개선 항목 찾기</Trans>
              ) : (
                <Trans comment="Button that runs the improvement scan again">다시 찾기</Trans>
              )}
            </Button>
          )
        }
      />
      {line !== null && <FieldDescription role="status">{line}</FieldDescription>}
      <PageError error={error} />
      {latest === null ? (
        <FieldDescription>
          <Trans>아직 개선 항목을 찾은 적이 없습니다.</Trans>
        </FieldDescription>
      ) : (
        <>
          <FieldDescription>
            <Trans>{ph({ time: koreanLocalTime(latest.generatedAt) })}에 찾은 결과입니다.</Trans>
          </FieldDescription>
          {latest.reports.length === 0 ? (
            <FieldDescription>
              <Trans>git 저장소인 열린 프로젝트가 없습니다.</Trans>
            </FieldDescription>
          ) : (
            latest.reports.map((report) => <Report key={report.repository} report={report} />)
          )}
        </>
      )}
    </FieldGroup>
  );
}
