import { Schema } from "effect";
import type { TraceTaskDetail, TraceTaskView } from "memory-agent";
import {
  ActivityIcon,
  ChevronRightIcon,
  CircleDotIcon,
  HistoryIcon,
  NetworkIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Separator } from "~/components/ui/separator";
import { api } from "./api";
import type { TraceConnection } from "./work-trace";

type PanelMode = "live" | "review";
const OpenTraceDetail = Schema.Struct({ taskId: Schema.String });
const depthPadding = ["pl-2", "pl-5", "pl-8", "pl-11"] as const;

const statusLabel: Readonly<Record<TraceTaskView["status"], string>> = {
  queued: "대기 중",
  running: "실행 중",
  waiting: "승인 대기",
  blocked: "확인 필요",
  interrupted: "중단됨",
  resumable: "재개 가능",
  resuming: "재개 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
  archived: "보관됨",
  deleted: "삭제됨",
};

function connectionLabel(connection: TraceConnection) {
  switch (connection) {
    case "connecting":
      return "연결 중";
    case "live":
      return "실시간 연결됨";
    case "reconnecting":
      return "저장된 기록 표시 중 · 재연결 중";
  }
}

type EvidenceLocator = NonNullable<TraceTaskDetail["evidence"][number]["locator"]>;
type ArtifactLocator = NonNullable<TraceTaskDetail["artifacts"][number]["locator"]>;

function evidenceLocatorLabel(locator: EvidenceLocator | null) {
  if (!locator) return "원본 위치가 삭제되었거나 가려졌어요.";
  switch (locator.kind) {
    case "message":
      return `Message ${locator.messageId} · Thread ${locator.threadId}`;
    case "tool_call":
      return `Tool call ${locator.toolCallId} · Thread ${locator.threadId}`;
    case "tool_result":
      return `Tool result ${locator.toolCallId} · Thread ${locator.threadId}`;
    case "checkpoint":
      return `Checkpoint ${locator.checkpointId}`;
    case "artifact":
      return `Artifact ${locator.artifactId}`;
    case "file":
      return `${locator.path} · sha256 ${locator.sha256}`;
    case "memory":
      return `Memory ${locator.memoryId}`;
  }
}

function artifactLocatorLabel(locator: ArtifactLocator | null) {
  if (!locator) return "원본 위치가 삭제되었거나 가려졌어요.";
  switch (locator.kind) {
    case "file":
      return `${locator.path} · sha256 ${locator.sha256}`;
    case "generated":
      return `Generated ${locator.reference}`;
    case "external":
      return `External ${locator.reference}`;
  }
}

function TaskTree({
  tasks,
  selectedTaskId,
  onSelect,
}: {
  tasks: readonly TraceTaskView[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const children = useMemo(() => {
    const index = new Map<string | null, TraceTaskView[]>();
    for (const task of tasks) {
      const parent =
        task.parentTaskId && tasks.some(({ id }) => id === task.parentTaskId)
          ? task.parentTaskId
          : null;
      index.set(parent, [...(index.get(parent) ?? []), task]);
    }
    return index;
  }, [tasks]);
  const branch = (parentId: string | null, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((task) => (
      <div key={task.id}>
        <button
          type="button"
          className={`flex w-full items-start gap-2 rounded-md py-2 pr-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${depthPadding[Math.min(depth, depthPadding.length - 1)]}`}
          aria-current={selectedTaskId === task.id ? "true" : undefined}
          onClick={() => onSelect(task.id)}
        >
          <ChevronRightIcon
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{task.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {task.agentName} · {task.latestActivity ?? task.request}
            </span>
          </span>
          <Badge
            variant={
              task.status === "blocked" || task.status === "failed" ? "destructive" : "secondary"
            }
          >
            {statusLabel[task.status]}
          </Badge>
        </button>
        {branch(task.id, depth + 1)}
      </div>
    ));
  return <nav aria-label="작업 트리">{branch(null, 0)}</nav>;
}

function TaskDetail({ detail }: { detail: TraceTaskDetail | null }) {
  if (!detail)
    return (
      <p className="p-4 text-sm text-muted-foreground">작업을 선택하면 실행 근거가 표시돼요.</p>
    );
  const task = detail.task;
  return (
    <div className="space-y-5 p-4">
      <section aria-labelledby="trace-overview">
        <div className="flex items-center gap-2">
          <h3 id="trace-overview" className="font-medium">
            {task.title}
          </h3>
          <Badge className="ml-auto" variant="outline">
            {statusLabel[task.status]}
          </Badge>
        </div>
        <p className="mt-2 text-sm">{task.request}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>에이전트</dt>
          <dd>{task.agentName}</dd>
          <dt>Task</dt>
          <dd className="truncate font-mono" title={task.id}>
            {task.id}
          </dd>
          <dt>Origin</dt>
          <dd>{task.originSessionId ?? "삭제된 대화 · project 기록 유지"}</dd>
        </dl>
      </section>
      <Separator />
      <section aria-labelledby="trace-attempts">
        <h3 id="trace-attempts" className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon className="size-4" aria-hidden /> 실행 이력
        </h3>
        <ol className="mt-2 space-y-2">
          {detail.attempts.map((attempt) => (
            <li key={attempt.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">Attempt {attempt.attemptNumber}</span>
                <Badge className="ml-auto" variant="secondary">
                  {attempt.status}
                </Badge>
              </div>
              <p className="mt-1 truncate text-muted-foreground" title={attempt.chatRunId}>
                Run {attempt.chatRunId}
              </p>
              {attempt.resumedFromAttemptId && (
                <p className="mt-1 text-muted-foreground">이전 attempt의 checkpoint에서 재개됨</p>
              )}
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="trace-checkpoints">
        <h3 id="trace-checkpoints" className="flex items-center gap-2 text-sm font-medium">
          <ShieldAlertIcon className="size-4" aria-hidden /> Checkpoint
        </h3>
        {detail.checkpoints.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">저장된 checkpoint가 없어요.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {detail.checkpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="rounded-md bg-muted/50 p-2 text-xs">
                <p>{checkpoint.remainingWork || "남은 작업이 기록되지 않았어요."}</p>
                <p className="mt-1 text-muted-foreground">
                  완료 tool {checkpoint.completedToolCallIds.length} · 불확실 tool{" "}
                  {checkpoint.uncertainToolCallIds.length} · 승인{" "}
                  {checkpoint.pendingApprovalIds.length}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="trace-evidence">
        <h3 id="trace-evidence" className="flex items-center gap-2 text-sm font-medium">
          <CircleDotIcon className="size-4" aria-hidden /> 근거와 결과
        </h3>
        {detail.evidence.length === 0 && detail.artifacts.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">연결된 근거나 결과물이 없어요.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {detail.evidence.map((evidence) => (
              <li key={evidence.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Evidence · {evidence.sourceKind}</span>
                  <Badge className="ml-auto" variant="secondary">
                    {evidence.verification}
                  </Badge>
                </div>
                <p className="mt-1 text-muted-foreground">
                  Attempt{" "}
                  {detail.attempts.find((attempt) => attempt.id === evidence.attemptId)
                    ?.attemptNumber ?? "?"}
                  {evidence.verification === "source_deleted" ? " · 원본 삭제됨" : ""}
                </p>
                <p className="mt-1 break-all font-mono text-muted-foreground">
                  {evidenceLocatorLabel(evidence.locator)}
                </p>
              </li>
            ))}
            {detail.artifacts.map((artifact) => (
              <li key={artifact.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Artifact · {artifact.kind}</span>
                  <Badge className="ml-auto" variant="secondary">
                    {artifact.verification}
                  </Badge>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {artifact.mediaType ?? "metadata"}
                  {artifact.verification === "source_deleted" ? " · 원본 삭제됨" : ""}
                </p>
                <p className="mt-1 break-all font-mono text-muted-foreground">
                  {artifactLocatorLabel(artifact.locator)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="trace-adoption">
        <h3 id="trace-adoption" className="flex items-center gap-2 text-sm font-medium">
          <CircleDotIcon className="size-4" aria-hidden /> 보고서 채택과 답변 출처
        </h3>
        {(detail.adoptions ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            아직 검토되거나 채택된 보고서가 없어요.
          </p>
        ) : (
          <ol className="mt-2 space-y-2">
            {(detail.adoptions ?? []).map((adoption) => (
              <li key={adoption.sequence} className="rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{adoption.disposition}</span>
                  <span className="ml-auto text-muted-foreground">
                    Attempt{" "}
                    {detail.attempts.find((attempt) => attempt.id === adoption.attemptId)
                      ?.attemptNumber ?? "?"}
                  </span>
                </div>
                {adoption.parentMessageId && (
                  <p className="mt-1 truncate font-mono text-muted-foreground">
                    Answer {adoption.parentMessageId}
                  </p>
                )}
                {adoption.supersededByAttemptId && (
                  <p className="mt-1 text-muted-foreground">새 attempt 보고서로 대체됨</p>
                )}
              </li>
            ))}
          </ol>
        )}
        {(detail.answerClaims ?? []).map((claim) => (
          <div key={claim.id} className="mt-2 rounded-md bg-muted/50 p-2 text-xs">
            <p className="font-medium">최종 답변 provenance</p>
            <p className="mt-1 truncate font-mono text-muted-foreground">
              Message {claim.parentMessageId}
            </p>
            <p className="mt-1 text-muted-foreground">
              연결된 evidence {claim.sources.filter((source) => source.evidenceRefId).length} ·
              반영된 상태 알림 {claim.notificationIds.length}
            </p>
          </div>
        ))}
      </section>
      <section aria-labelledby="trace-memory">
        <h3 id="trace-memory" className="flex items-center gap-2 text-sm font-medium">
          <CircleDotIcon className="size-4" aria-hidden /> Decision과 Memory
        </h3>
        {(detail.memoryCandidates ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            이 작업에서 승격을 검토한 memory candidate가 없어요.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {(detail.memoryCandidates ?? []).map((candidate) => {
              const usage = (detail.memoryUsage ?? []).filter(
                (item) => item.candidateId === candidate.id,
              );
              return (
                <li key={candidate.id} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{candidate.disposition}</span>
                    <Badge className="ml-auto" variant="secondary">
                      {candidate.memoryNodeId ? "project memory" : "저장 안 함"}
                    </Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap">{candidate.resolvedText}</p>
                  {candidate.proposedText !== candidate.resolvedText && (
                    <p className="mt-1 text-muted-foreground">사용자가 문구를 수정해 저장했어요.</p>
                  )}
                  <p className="mt-1 text-muted-foreground">
                    채택된 evidence {candidate.evidence.length} · 조회{" "}
                    {usage.filter((item) => item.kind === "retrieved").length} · 답변 사용{" "}
                    {usage.filter((item) => item.kind === "used").length}
                  </p>
                  {candidate.originSessionId === null && (
                    <p className="mt-1 text-muted-foreground">
                      원본 대화 삭제됨 · project provenance 유지
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="trace-activity">
        <h3 id="trace-activity" className="flex items-center gap-2 text-sm font-medium">
          <ActivityIcon className="size-4" aria-hidden /> 활동
        </h3>
        <ol className="mt-2 space-y-3 border-l pl-3">
          {detail.events.map((event) => (
            <li key={event.id} className="text-xs">
              <p>{event.summary}</p>
              <p className="mt-0.5 text-muted-foreground">
                {event.kind} · #{event.attemptSequence}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function PanelBody({
  projectId,
  sessionId,
  selectedTaskId,
  onSelectedTaskIdChange,
}: {
  projectId: string;
  sessionId: string | null;
  selectedTaskId: string | null;
  onSelectedTaskIdChange: (taskId: string | null) => void;
}) {
  const [mode, setMode] = useState<PanelMode>("live");
  const [tasks, setTasks] = useState<readonly TraceTaskView[]>([]);
  const [detail, setDetail] = useState<TraceTaskDetail | null>(null);
  const [connection, setConnection] = useState<TraceConnection>("connecting");
  const [failed, setFailed] = useState(false);
  const refresh = useEffectEvent(async () => {
    try {
      const snapshot = await api.projectWorkTrace(projectId);
      setTasks(snapshot.tasks);
      setFailed(false);
      const preferred =
        selectedTaskId && snapshot.tasks.some(({ id }) => id === selectedTaskId)
          ? selectedTaskId
          : (snapshot.tasks[0]?.id ?? null);
      if (preferred !== selectedTaskId) onSelectedTaskIdChange(preferred);
    } catch {
      setFailed(true);
    }
  });
  useEffect(() => void refresh(), [projectId]);
  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener("work-trace:changed", changed);
    return () => window.removeEventListener("work-trace:changed", changed);
  }, []);
  useEffect(() => {
    if (!sessionId || mode !== "live") {
      setConnection("connecting");
      return;
    }
    const source = new EventSource(api.workTraceStreamUrl(sessionId));
    const changed = () => void refresh();
    source.addEventListener("open", () => setConnection("live"));
    source.addEventListener("trace", changed);
    source.addEventListener("snapshot", changed);
    source.addEventListener("error", () => setConnection("reconnecting"));
    return () => source.close();
  }, [mode, sessionId]);
  const shownTasks =
    mode === "live" && sessionId
      ? tasks.filter((task) => task.originSessionId === sessionId)
      : tasks;
  useEffect(() => {
    if (selectedTaskId && shownTasks.some(({ id }) => id === selectedTaskId)) return;
    onSelectedTaskIdChange(shownTasks[0]?.id ?? null);
  }, [mode, sessionId, tasks]);
  useEffect(() => {
    if (!selectedTaskId) return setDetail(null);
    let current = true;
    void api.projectWorkTraceTask(projectId, selectedTaskId).then(
      (next) => current && setDetail(next),
      () => current && setDetail(null),
    );
    return () => {
      current = false;
    };
  }, [projectId, selectedTaskId, tasks]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex items-center gap-1 border-b p-2"
        role="toolbar"
        aria-label="Work Trace 보기 모드"
      >
        <Button
          size="xs"
          variant={mode === "live" ? "secondary" : "ghost"}
          onClick={() => setMode("live")}
        >
          Live
        </Button>
        <Button
          size="xs"
          variant={mode === "review" ? "secondary" : "ghost"}
          onClick={() => setMode("review")}
        >
          Review
        </Button>
        <span
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
          role="status"
        >
          {mode === "review" ? "저장된 전체 기록" : connectionLabel(connection)}
          {connection === "reconnecting" && <RefreshCwIcon className="size-3" aria-hidden />}
        </span>
      </div>
      {failed && (
        <p className="border-b px-3 py-2 text-xs text-destructive">
          Work Trace를 불러오지 못했어요.
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(8rem,35%)_1fr]">
        <div className="min-h-0 border-b">
          <ScrollArea className="h-full">
            <div className="p-2">
              {shownTasks.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">아직 기록된 작업이 없어요.</p>
              ) : (
                <TaskTree
                  tasks={shownTasks}
                  selectedTaskId={selectedTaskId}
                  onSelect={onSelectedTaskIdChange}
                />
              )}
            </div>
          </ScrollArea>
        </div>
        <ScrollArea className="min-h-0 h-full">
          <TaskDetail detail={detail} />
        </ScrollArea>
      </div>
    </div>
  );
}

export function WorkTracePanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  useEffect(() => {
    const show = (event: Event) => {
      const taskId =
        event instanceof CustomEvent && Schema.is(OpenTraceDetail)(event.detail)
          ? event.detail.taskId
          : null;
      setSelectedTaskId(taskId);
      setOpen(true);
    };
    window.addEventListener("work-trace:open", show);
    return () => window.removeEventListener("work-trace:open", show);
  }, []);
  return (
    <>
      {!open && (
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="fixed top-3 right-3 z-30"
          aria-label="Work Trace 열기"
          onClick={() => setOpen(true)}
        >
          <PanelRightOpenIcon />
        </Button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="min-w-0 overflow-hidden">
          <SheetHeader>
            <SheetTitle>
              <span className="flex items-center gap-2">
                <NetworkIcon className="size-4" aria-hidden /> Work Trace
              </span>
            </SheetTitle>
            <SheetDescription>저장된 작업 계층과 실행 근거를 확인해요.</SheetDescription>
          </SheetHeader>
          <PanelBody
            projectId={projectId}
            sessionId={sessionId}
            selectedTaskId={selectedTaskId}
            onSelectedTaskIdChange={setSelectedTaskId}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
