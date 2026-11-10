import { isTruthy } from "../../truthy.ts";
import { Array as Arr, Data, Schema } from "effect";
import type { HeartbeatState, TraceTaskDetail, TraceTaskView } from "memory-agent";
import {
  ActivityIcon,
  ChevronRightIcon,
  CircleDotIcon,
  HistoryIcon,
  NetworkIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { koreanTimeOfDayOf } from "../shared/local-time";
import { failureLabel } from "../session/attempt-failure";
import type { TraceConnection } from "../session/work-trace";
import { useProjectTraceConnection } from "../session/use-project-trace-connection";
import { useProjectTraceQuery, useProjectTraceTaskQuery } from "../queries/project";
import { chatCopy } from "./copy";

const copy = chatCopy.workTrace;

type PanelMode = "live" | "review";
const OpenTraceDetail = Schema.Struct({ taskId: Schema.String });
const depthPadding = ["pl-2", "pl-5", "pl-8", "pl-11"] as const;

const statusLabel: Readonly<Record<TraceTaskView["status"], string>> = copy.status;

const connectionLabel = (connection: TraceConnection) => copy.connection[connection];

type ArtifactLocator = NonNullable<TraceTaskDetail["artifacts"][number]["locator"]>;
const ArtifactLocator = Data.taggedEnum<ArtifactLocator>();

const heartbeatLabel: Readonly<Record<HeartbeatState, string>> = copy.heartbeat;

const locatorLabel = ArtifactLocator.$match({
  file: ({ path, sha256 }) => `${path} · sha256 ${sha256}`,
  generated: ({ reference }) => `Generated ${reference}`,
  external: ({ reference }) => `External ${reference}`,
});

function artifactLocatorLabel(locator: ArtifactLocator | null) {
  if (!isTruthy(locator)) return copy.locatorMissing;
  return locatorLabel(locator);
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
  const branch = (parentId: string | null, depth: number): React.ReactNode =>
    tasks
      .filter((task) =>
        parentId === null
          ? task.parentTaskId === null || !tasks.some(({ id }) => id === task.parentTaskId)
          : task.parentTaskId === parentId,
      )
      .map((task) => (
        <div key={task.id} className="min-w-0">
          <button
            type="button"
            className={`flex w-full min-w-0 items-start gap-2 rounded-md py-2 pr-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${depthPadding[Math.min(depth, depthPadding.length - 1)]}`}
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
                {task.agentName} · {task.heartbeat?.step ?? task.request}
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
  return (
    <nav className="min-w-0" aria-label={copy.tree}>
      {branch(null, 0)}
    </nav>
  );
}

function TaskDetail({ detail }: { detail: TraceTaskDetail | null }) {
  if (!(detail !== null))
    return <p className="p-4 text-sm text-muted-foreground">{copy.selectTask}</p>;
  const task = detail.task;
  return (
    <div className="min-w-0 space-y-5 p-4 break-words">
      <section className="min-w-0" aria-labelledby="trace-overview">
        <div className="flex min-w-0 items-center gap-2">
          <h3 id="trace-overview" className="min-w-0 break-words font-medium">
            {task.title}
          </h3>
          <Badge className="ml-auto" variant="outline">
            {statusLabel[task.status]}
          </Badge>
        </div>
        <p className="mt-2 text-sm">{task.request}</p>
        {task.heartbeat !== null && (
          <p className="mt-2 text-xs text-muted-foreground">
            {heartbeatLabel[task.heartbeat.state]} · {task.heartbeat.step} ·{" "}
            {koreanTimeOfDayOf(task.heartbeat.at)}
          </p>
        )}
        {task.latestFailure !== null && (
          <p className="mt-1 text-xs text-destructive">{failureLabel(task.latestFailure)}</p>
        )}
        <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>{copy.agent}</dt>
          <dd className="min-w-0 break-words">{task.agentName}</dd>
          <dt>Task</dt>
          <dd className="min-w-0 truncate font-mono" title={task.id}>
            {task.id}
          </dd>
          <dt>Origin</dt>
          <dd className="min-w-0 break-all">{task.originSessionId ?? copy.originDeleted}</dd>
        </dl>
      </section>
      <Separator />
      <section aria-labelledby="trace-attempts">
        <h3 id="trace-attempts" className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon className="size-4" aria-hidden /> {copy.attempts}
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
                <p className="mt-1 text-muted-foreground">{copy.resumedAttempt}</p>
              )}
              {attempt.failure !== null && (
                <p className="mt-1 text-destructive">{failureLabel(attempt.failure)}</p>
              )}
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="trace-artifacts">
        <h3 id="trace-artifacts" className="flex items-center gap-2 text-sm font-medium">
          <CircleDotIcon className="size-4" aria-hidden /> {copy.artifacts}
        </h3>
        {detail.artifacts.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{copy.noArtifacts}</p>
        ) : (
          <ul className="mt-2 space-y-2">
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
                  {artifact.verification === "source_deleted" ? copy.sourceDeleted : ""}
                </p>
                <p className="mt-1 break-all font-mono text-muted-foreground">
                  {artifactLocatorLabel(artifact.locator)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="trace-answers">
        <h3 id="trace-answers" className="flex items-center gap-2 text-sm font-medium">
          <CircleDotIcon className="size-4" aria-hidden /> {copy.answers}
        </h3>
        {detail.answerClaims.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">{copy.noAnswer}</p>
        )}
        {detail.answerClaims.map((claim) => (
          <div key={claim.id} className="mt-2 rounded-md bg-muted/50 p-2 text-xs">
            <p className="font-medium">{copy.answerProvenance}</p>
            <p className="mt-1 truncate font-mono text-muted-foreground">
              Message {claim.parentMessageId}
            </p>
            <p className="mt-1 text-muted-foreground">
              {copy.claimCounts(claim.sources.length, claim.notificationIds.length)}
            </p>
          </div>
        ))}
      </section>
      <section aria-labelledby="trace-memory">
        <h3 id="trace-memory" className="flex items-center gap-2 text-sm font-medium">
          <CircleDotIcon className="size-4" aria-hidden /> {copy.memory}
        </h3>
        {(detail.memoryCandidates ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{copy.noCandidates}</p>
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
                      {isTruthy(candidate.memoryNodeId) ? "project memory" : copy.notSaved}
                    </Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap">{candidate.resolvedText}</p>
                  {candidate.proposedText !== candidate.resolvedText && (
                    <p className="mt-1 text-muted-foreground">{copy.editedByUser}</p>
                  )}
                  <p className="mt-1 text-muted-foreground">
                    {copy.candidateCounts(
                      candidate.evidence.length,
                      Arr.countBy(usage, (item) => item.kind === "retrieved"),
                      Arr.countBy(usage, (item) => item.kind === "used"),
                    )}
                  </p>
                  {candidate.originSessionId === null && (
                    <p className="mt-1 text-muted-foreground">{copy.originDeletedProvenance}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="trace-activity">
        <h3 id="trace-activity" className="flex items-center gap-2 text-sm font-medium">
          <ActivityIcon className="size-4" aria-hidden /> {copy.activity}
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
  const traceQuery = useProjectTraceQuery(projectId);
  const taskQuery = useProjectTraceTaskQuery(projectId, selectedTaskId);
  const tasks = traceQuery.data?.tasks ?? [];
  const detail = taskQuery.data ?? null;
  const failed = traceQuery.isError;
  const connection = useProjectTraceConnection(projectId, sessionId, mode === "live");
  const shownTasks =
    mode === "live" && isTruthy(sessionId)
      ? tasks.filter((task) => task.originSessionId === sessionId)
      : tasks;
  useEffect(() => {
    if (isTruthy(selectedTaskId) && shownTasks.some(({ id }) => id === selectedTaskId)) return;
    onSelectedTaskIdChange(shownTasks[0]?.id ?? null);
  }, [mode, sessionId, tasks]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex min-w-0 items-center gap-1 border-b p-2"
        role="toolbar"
        aria-label={copy.modeToolbar}
      >
        <Button
          size="sm"
          variant={mode === "live" ? "secondary" : "ghost"}
          onClick={() => setMode("live")}
        >
          Live
        </Button>
        <Button
          size="sm"
          variant={mode === "review" ? "secondary" : "ghost"}
          onClick={() => setMode("review")}
        >
          Review
        </Button>
        <span
          className="ml-auto flex min-w-0 items-center justify-end gap-1 text-right text-xs text-muted-foreground"
          role="status"
        >
          {mode === "review" ? copy.reviewAll : connectionLabel(connection)}
          {connection === "reconnecting" && <RefreshCwIcon className="size-3" aria-hidden />}
        </span>
      </div>
      {failed && <p className="border-b px-3 py-2 text-xs text-destructive">{copy.loadFailed}</p>}
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(8rem,35%)_1fr]">
        <div className="min-h-0 min-w-0 border-b">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 p-2">
              {shownTasks.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{copy.empty}</p>
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
        <ScrollArea className="h-full min-h-0 min-w-0">
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
          aria-label={copy.open}
          onClick={() => setOpen(true)}
        >
          <PanelRightOpenIcon />
        </Button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="min-w-0">
          <SheetHeader>
            <SheetTitle>
              <span className="flex items-center gap-2">
                <NetworkIcon aria-hidden /> Work Trace
              </span>
            </SheetTitle>
            <SheetDescription>{copy.description}</SheetDescription>
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
