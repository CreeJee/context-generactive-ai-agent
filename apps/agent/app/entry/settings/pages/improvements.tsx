import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { Effect, Match, Option, Schema } from "effect";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import type { ImprovementReport, ImprovementScan } from "memory-agent";
import { reportedTitle, type ScanFailure, ScanState, sourceLabels } from "memory-agent/definitions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { appFetch } from "../../shared/backend-restart";
import { PageError, PageHeader, shortPath } from "../shared";

class ImprovementRequestFailed extends Schema.TaggedError<ImprovementRequestFailed>()(
  "ImprovementRequestFailed",
  { message: Schema.String },
) {}

const queryKey = ["settings", "improvements"];

/** Why a request or a scan failed, as the server names it. */
const FailureBody = Schema.Struct({ reason: Schema.Literals(["report"]) });
const failures: Record<ScanFailure, string> = {
  storage: "프로젝트 사용 기록을 읽지 못했어요.",
  report: "개선 문서를 쓰거나 읽지 못했어요.",
  embedding: "임베딩 모델로 비슷한 정정을 묶지 못했어요. 임베딩 설정을 확인하세요.",
  model_unavailable:
    "개선 항목을 해석할 모델이 없어요. 채팅에서 모델을 고르고 로그인한 뒤 다시 시도하세요.",
  model_unreachable:
    "모델 서버가 응답하지 않아 찾기를 멈췄어요. 모델 서버 연결을 확인한 뒤 다시 시도하세요.",
  internal: "개선 항목을 찾는 중 오류가 났어요. 다시 시도하세요.",
};

interface Status {
  readonly state: ScanState;
  readonly scan: ImprovementScan | null;
}

/** One line on where the scan stands; nothing while idle. */
const stateLine = ScanState.match({
  idle: () => null,
  running: ({ repositories, items }) =>
    repositories.total === 0
      ? "사용 기록에서 신호를 모으는 중이에요."
      : `찾는 중이에요. 저장소 ${repositories.done}/${repositories.total} · 해석한 항목 ${items.done}/${items.total}`,
  failed: ({ reason }) => failures[reason],
  stopped: () => "찾기를 중지했어요. 이전 결과는 그대로예요.",
});

type ReportedItem = ImprovementReport["items"][number];
const byStatus = Match.discriminatorsExhaustive("status");
const itemRule = (item: ReportedItem) =>
  Match.value(item.interpretation).pipe(
    byStatus({
      interpreted: ({ rule }) => `지침: ${rule}`,
      failed: () => "모델이 해석하지 못했어요. 문서의 근거를 직접 확인하세요.",
    }),
  );

/** What a failed request says: this page's own wording, never a browser or transport message. */
const requestFailure = (failure: Error) =>
  Schema.is(ImprovementRequestFailed)(failure) ? failure.message : "요청을 처리하지 못했어요.";

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
function request<A>(action?: "start" | "stop"): Promise<A> {
  return runUiEffect(
    Effect.gen(function* () {
      const response = yield* uiPromise(() =>
        appFetch(
          "/api/settings/improvements",
          action === undefined
            ? undefined
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action }),
              },
        ),
      );
      if (!response.ok) {
        if (response.status === 404)
          return yield* ImprovementRequestFailed.make({
            message:
              "실행 중인 서버가 프로젝트 개선을 지원하지 않아요. 앱 서버를 재시작한 뒤 다시 시도하세요.",
          });
        const body: unknown = yield* uiPromise(() => response.json());
        return yield* ImprovementRequestFailed.make({
          message: Option.match(Schema.decodeUnknownOption(FailureBody)(body), {
            onNone: () => "요청을 처리하지 못했어요.",
            onSome: ({ reason }) => failures[reason],
          }),
        });
      }
      return yield* uiPromise<A>(() => response.json());
    }),
  );
}

function Report({ report }: { report: ImprovementReport }) {
  const [copied, setCopied] = useState(false);
  const name = report.repository.split(/[/\\]/u).at(-1) ?? report.repository;
  return (
    <section className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{name}</h4>
        <Badge variant="secondary">{report.items.length}개 항목</Badge>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {shortPath(report.repository)}
        </span>
      </div>
      {report.items.length === 0 ? (
        <FieldDescription>반복된 정정이나 실패가 없어 고칠 항목이 없어요.</FieldDescription>
      ) : (
        <ol className="flex flex-col gap-1 text-xs">
          {report.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <Badge variant="outline">{sourceLabels[item.source]}</Badge>
                <span className="min-w-0 flex-1 truncate">{reportedTitle(item)}</span>
                <span className="shrink-0 text-muted-foreground">{item.count}회</span>
              </div>
              <span className="pl-1 text-muted-foreground">{itemRule(item)}</span>
            </li>
          ))}
        </ol>
      )}
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
          <ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
          작업 명세 문서 보기
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
              {copied ? "복사했어요" : "문서 복사"}
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
    queryFn: () => request<Status>(),
    // Follow a running scan; otherwise the page only changes when the user acts.
    refetchInterval: (query) =>
      query.state.data !== undefined && ScanState.guards.running(query.state.data.state)
        ? 2000
        : false,
    retry: false,
  });
  const command = useMutation({
    mutationFn: (action: "start" | "stop") => request<Pick<Status, "state">>(action),
    onSuccess: ({ state }) => {
      setError(null);
      cache.setQueryData<Status>(queryKey, (current) =>
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
        title="프로젝트 개선"
        description="열린 프로젝트의 최근 90일 사용 기록에서 반복된 정정과 실패를 찾아, 저장소마다 고칠 항목과 작업 명세를 문서로 남겨요. 코드와 에이전트 지침을 함께 고치는 명세예요. 앱은 저장소를 직접 바꾸지 않아요."
        action={
          running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={command.isPending}
              onClick={() => command.mutate("stop")}
            >
              중지
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={command.isPending || data === undefined}
              onClick={() => command.mutate("start")}
            >
              {latest === null ? "개선 항목 찾기" : "다시 찾기"}
            </Button>
          )
        }
      />
      {line !== null && <FieldDescription role="status">{line}</FieldDescription>}
      <PageError error={error ?? (queryError === null ? null : requestFailure(queryError))} />
      {data === undefined ? (
        queryError === null && (
          <FieldDescription role="status">기록한 개선 항목을 불러오는 중이에요.</FieldDescription>
        )
      ) : latest === null ? (
        <FieldDescription>아직 개선 항목을 찾은 적이 없어요.</FieldDescription>
      ) : (
        <>
          <FieldDescription>
            {new Date(latest.generatedAt).toLocaleString()}에 찾은 결과예요.
          </FieldDescription>
          {latest.reports.length === 0 ? (
            <FieldDescription>git 저장소인 열린 프로젝트가 없어요.</FieldDescription>
          ) : (
            latest.reports.map((report) => <Report key={report.repository} report={report} />)
          )}
        </>
      )}
    </FieldGroup>
  );
}
