import { SchemaTransformation } from "effect";
import type { UIMessage } from "@tanstack/ai-react";
import { Option, Schema } from "effect";
import { BotIcon, ChevronRightIcon, Clock3Icon, WrenchIcon } from "lucide-react";
import type { TraceTaskView } from "memory-agent";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { attachmentIdOf, attachmentUrl, type QueuedMessage } from "memory-agent/definitions";
import { DrawingPicture, UserMessageBody } from "./images";
import { Markdown } from "./markdown";
import { taskForToolCall, type TraceConnection } from "../session/work-trace";

type Part = UIMessage["parts"][number];
type ToolCall = Extract<Part, { type: "tool-call" }>;
type ToolResult = Extract<Part, { type: "tool-result" }>;

const toolLabels = {
  find_memory: "기억 검색",
  read_evidence: "원문 읽기",
  trace_evidence: "근거 추적",
  list_files: "파일 목록",
  search_files: "파일 내용 검색",
  read_file: "파일 읽기",
  write_file: "파일 쓰기",
  edit_file: "파일 편집",
  delete_file: "파일 삭제",
  list_outside_files: "프로젝트 밖 파일 목록",
  read_outside_file: "프로젝트 밖 파일 읽기",
  search_outside_file: "프로젝트 밖 파일 검색",
  run_shell: "셸 실행",
  write_outside_file: "프로젝트 밖 파일 쓰기",
  delete_outside_file: "프로젝트 밖 파일 삭제",
  kagi_search: "웹 검색",
  kagi_extract: "웹 페이지 읽기",
  read_skill: "skill 읽기",
  run_subagent: "서브에이전트 실행",
  message_subagent: "서브에이전트에게 메시지 보내기",
  delegate_to_agent: "외부 에이전트에게 맡기기",
} satisfies Record<string, string>;

/** Built-in tools by their label; MCP tools (`mcp_<server>__<tool>`) as "MCP server · tool". */
function toolLabel(name: string) {
  const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  return (
    Object.entries(toolLabels).find(([tool]) => tool === name)?.[1] ??
    (mcp ? `MCP ${mcp[1]} · ${mcp[2]}` : name)
  );
}

function pretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function resultText(result: ToolResult) {
  return Array.isArray(result.content)
    ? result.content
        .map((part) => (part.type === "text" ? part.content : `[${part.type}]`))
        .join("")
    : result.content;
}

/** Where a tool call stands, as the badge shows it. */
type CallStatus =
  | { readonly kind: "running" }
  | { readonly kind: "awaiting-approval" }
  | { readonly kind: "completed" }
  | { readonly kind: "failed" }
  | { readonly kind: "denied" }
  | { readonly kind: "blocked" };

/**
 * What a result says happened. A declined approval and a call the permission review refused are
 * returned as ordinary results, so their content decides, not the transport state.
 */
const RefusedResult = Schema.Union([
  Schema.fromJsonString(Schema.Struct({ approved: Schema.Literal(false) })).pipe(
    Schema.decodeTo(
      Schema.Literal("denied"),
      SchemaTransformation.transform({
        decode: () => "denied" as const,
        encode: () => ({ approved: false as const }),
      }),
    ),
  ),
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.String.pipe(Schema.check(Schema.isStartsWith("blocked_by_permission_review"))),
    }),
  ).pipe(
    Schema.decodeTo(
      Schema.Literal("blocked"),
      SchemaTransformation.transform({
        decode: () => "blocked" as const,
        encode: () => ({ error: "blocked_by_permission_review" }),
      }),
    ),
  ),
]);
const decodeRefusal = Schema.decodeUnknownOption(RefusedResult);

/** A write_file / edit_file result that carries a picture of the SVG it wrote. */
const decodeDrawing = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      path: Schema.String,
      preview: Schema.Struct({ attachmentId: Schema.String }),
    }),
  ),
);

/** The picture to show for a result, when it is one of this app's stored images. */
function drawingOf(result: ToolResult | undefined) {
  if (!result) return null;
  const drawing = Option.getOrUndefined(decodeDrawing(resultText(result)));
  if (!drawing) return null;
  const url = attachmentUrl(drawing.preview.attachmentId);
  return attachmentIdOf(url) ? { url, path: drawing.path } : null;
}

function callStatus(call: ToolCall, result: ToolResult | undefined, awaitingApproval: boolean) {
  if (!result)
    return awaitingApproval || call.state === "approval-requested"
      ? ({ kind: "awaiting-approval" } satisfies CallStatus)
      : ({ kind: "running" } satisfies CallStatus);
  const refusal = Option.getOrUndefined(decodeRefusal(resultText(result)));
  if (refusal) return { kind: refusal } satisfies CallStatus;
  return result.state === "error"
    ? ({ kind: "failed" } satisfies CallStatus)
    : ({ kind: "completed" } satisfies CallStatus);
}

function StatusBadge({ status }: { status: CallStatus }) {
  switch (status.kind) {
    case "running":
      return <Badge variant="outline">실행 중</Badge>;
    case "awaiting-approval":
      return <Badge variant="outline">승인 대기</Badge>;
    case "completed":
      return <Badge variant="secondary">완료</Badge>;
    case "failed":
      return <Badge variant="destructive">실패</Badge>;
    case "denied":
      return <Badge variant="destructive">거부됨</Badge>;
    case "blocked":
      return <Badge variant="destructive">자동 검토로 막힘</Badge>;
  }
}

const activeTaskStatuses: readonly TraceTaskView["status"][] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "resuming",
];

function elapsed(task: TraceTaskView) {
  const milliseconds = Math.max(
    0,
    (activeTaskStatuses.includes(task.status) ? Date.now() : task.updatedAt) - task.createdAt,
  );
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${Math.max(1, seconds)}초`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}분` : `${Math.round(minutes / 60)}시간`;
}

function taskStatus(task: TraceTaskView) {
  switch (task.status) {
    case "queued":
      return { label: "대기 중", variant: "outline" as const };
    case "running":
      return { label: "실행 중", variant: "outline" as const };
    case "waiting":
      return { label: "승인 대기", variant: "outline" as const };
    case "blocked":
      return { label: "확인 필요", variant: "destructive" as const };
    case "interrupted":
      return { label: "중단됨", variant: "destructive" as const };
    case "resumable":
      return { label: "재개 가능", variant: "destructive" as const };
    case "resuming":
      return { label: "새 실행으로 재개 중", variant: "outline" as const };
    case "completed":
      return { label: "완료", variant: "secondary" as const };
    case "failed":
      return { label: "실패", variant: "destructive" as const };
    case "cancelled":
      return { label: "중단됨", variant: "destructive" as const };
    case "archived":
      return { label: "보관됨", variant: "secondary" as const };
    case "deleted":
      return { label: "삭제됨", variant: "secondary" as const };
  }
}

type ResumeActionResult =
  | { readonly status: "queued" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "failed" };
type ArchiveActionResult =
  | { readonly status: "archived" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "failed" };
type DeleteActionResult =
  | { readonly status: "deleted" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "failed" };
const archivableTaskStatuses: readonly TraceTaskView["status"][] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "interrupted",
  "resumable",
  "resuming",
  "completed",
  "failed",
  "cancelled",
];

function TaskSummaryCard({
  task,
  connection,
  readOnly,
  onResume,
  onArchive,
  onDelete,
}: {
  task: TraceTaskView;
  connection: TraceConnection;
  readOnly: boolean;
  onResume: (task: TraceTaskView, confirmUncertain: boolean) => Promise<ResumeActionResult>;
  onArchive: (task: TraceTaskView) => Promise<ArchiveActionResult>;
  onDelete: (task: TraceTaskView) => Promise<DeleteActionResult>;
}) {
  const status = taskStatus(task);
  const active = activeTaskStatuses.includes(task.status);
  const [resumeState, setResumeState] = useState<
    "idle" | "requesting" | "confirm-uncertain" | "queued" | "failed"
  >("idle");
  const resume = async (confirmUncertain: boolean) => {
    setResumeState("requesting");
    const result = await onResume(task, confirmUncertain);
    if (result.status === "queued") return setResumeState("queued");
    if (result.status === "blocked" && result.reason === "uncertain_side_effect")
      return setResumeState("confirm-uncertain");
    setResumeState("failed");
  };
  const [archiveState, setArchiveState] = useState<"idle" | "requesting" | "failed">("idle");
  const archive = async () => {
    setArchiveState("requesting");
    const result = await onArchive(task);
    setArchiveState(result.status === "archived" ? "idle" : "failed");
  };
  const [deleteState, setDeleteState] = useState<"idle" | "requesting" | "failed">("idle");
  const remove = async () => {
    if (
      !window.confirm(
        "이 작업의 transcript·checkpoint·locator를 삭제할까요? 채택된 project memory와 provenance는 유지돼요.",
      )
    )
      return;
    setDeleteState("requesting");
    const result = await onDelete(task);
    setDeleteState(result.status === "deleted" ? "idle" : "failed");
  };
  const openTrace = () =>
    window.dispatchEvent(new CustomEvent("work-trace:open", { detail: { taskId: task.id } }));
  return (
    <section
      className="min-w-72 rounded-lg border bg-muted/30 px-3 py-2.5"
      aria-label={`서브에이전트 작업: ${task.title}`}
    >
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{task.agentName ?? "서브에이전트"}</span>
        <Badge className="ml-auto shrink-0" variant={status.variant}>
          {status.label}
        </Badge>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm">{task.request}</p>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3Icon className="size-3.5" aria-hidden />
        <span>{elapsed(task)}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">
          {active && connection !== "live"
            ? "실행 상태에 다시 연결 중"
            : (task.latestActivity ?? "작업 기록을 준비하는 중")}
        </span>
      </div>
      {task.latestResumedFromAttemptId && (
        <p className="mt-1 text-xs text-muted-foreground">이전 실행에서 새 attempt로 재개됨</p>
      )}
      {task.status === "resumable" && (
        <p className="mt-1 text-xs text-destructive">
          실행 연결이 소실됐어요. checkpoint에서 새 attempt로 재개할 수 있어요.
        </p>
      )}
      {resumeState === "confirm-uncertain" && (
        <p className="mt-1 text-xs text-destructive">
          완료 여부가 불확실한 도구가 있어요. 중복 side effect 가능성을 확인해야 해요.
        </p>
      )}
      {resumeState === "failed" && (
        <p className="mt-1 text-xs text-destructive">최신 상태에서 재개할 수 없어요.</p>
      )}
      <div className="mt-2 flex items-center justify-end gap-1">
        {task.status === "resumable" && task.latestAttemptId && (
          <Button
            type="button"
            size="xs"
            variant={resumeState === "confirm-uncertain" ? "destructive" : "outline"}
            disabled={readOnly || resumeState === "requesting" || resumeState === "queued"}
            onClick={() => void resume(resumeState === "confirm-uncertain")}
          >
            {resumeState === "requesting"
              ? "요청 중"
              : resumeState === "queued"
                ? "재개 요청됨"
                : resumeState === "confirm-uncertain"
                  ? "위험 확인 후 재개"
                  : "재개"}
          </Button>
        )}
        {archivableTaskStatuses.includes(task.status) && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={readOnly || archiveState === "requesting"}
            onClick={() => void archive()}
          >
            {archiveState === "requesting"
              ? "보관 중"
              : archiveState === "failed"
                ? "보관 재시도"
                : "보관"}
          </Button>
        )}
        {task.status !== "deleted" && (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={readOnly || deleteState === "requesting"}
            onClick={() => void remove()}
          >
            {deleteState === "requesting"
              ? "삭제 중"
              : deleteState === "failed"
                ? "삭제 재시도"
                : "삭제"}
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={openTrace}>
          Work Trace에서 보기
        </Button>
      </div>
    </section>
  );
}

function ToolCallView({
  call,
  result,
  awaitingApproval,
  task,
  traceConnection,
  readOnly,
  onResumeTask,
  onArchiveTask,
  onDeleteTask,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  awaitingApproval: boolean;
  task: TraceTaskView | undefined;
  traceConnection: TraceConnection;
  readOnly: boolean;
  onResumeTask: (task: TraceTaskView, confirmUncertain: boolean) => Promise<ResumeActionResult>;
  onArchiveTask: (task: TraceTaskView) => Promise<ArchiveActionResult>;
  onDeleteTask: (task: TraceTaskView) => Promise<DeleteActionResult>;
}) {
  const drawing = drawingOf(result);
  return (
    <div className="flex flex-col gap-1.5">
      {task ? (
        <TaskSummaryCard
          task={task}
          connection={traceConnection}
          readOnly={readOnly}
          onResume={onResumeTask}
          onArchive={onArchiveTask}
          onDelete={onDeleteTask}
        />
      ) : (
        <ToolCallCard call={call} result={result} awaitingApproval={awaitingApproval} />
      )}
      {/* Outside the collapsed card: the picture is the point of the call. */}
      {drawing && <DrawingPicture url={drawing.url} path={drawing.path} />}
    </div>
  );
}

function ToolCallCard({
  call,
  result,
  awaitingApproval,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  awaitingApproval: boolean;
}) {
  return (
    <Collapsible className="rounded-md border bg-muted/30 text-xs">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{toolLabel(call.name)}</span>
        <code className="text-muted-foreground">{call.name}</code>
        <span className="ml-auto">
          <StatusBadge status={callStatus(call, result, awaitingApproval)} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-2.5 py-2">
        <div>
          <div className="mb-1 text-muted-foreground">인자</div>
          <pre className="max-h-48 overflow-auto rounded bg-background p-2 whitespace-pre-wrap break-all">
            {pretty(call.arguments)}
          </pre>
        </div>
        {result && (
          <div>
            <div className="mb-1 text-muted-foreground">결과</div>
            <pre className="max-h-72 overflow-auto rounded bg-background p-2 whitespace-pre-wrap break-all">
              {pretty(resultText(result))}
            </pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One chat message. Assistant text renders as Markdown (`streaming` while it is still arriving);
 * user text stays exactly as typed. Tool calls show what was looked up and what came back.
 */
/**
 * A message the running answer took in (steered, or at a tool call). It shows where the saved
 * conversation will have it, until the run ends and the conversation is read again.
 */
export function DeliveredMessageView({ message }: { message: QueuedMessage }) {
  const images = message.attachmentIds.map((id, index) => ({
    number: index + 1,
    url: attachmentUrl(id),
  }));
  return (
    <div className="flex flex-col items-end gap-1">
      <UserMessageBody text={message.text} images={images} />
      <span className="text-2xs text-muted-foreground">
        {message.state.kind === "delivered" && message.state.via === "steer"
          ? "답변 중에 바로 전달했어요"
          : "도구 호출 뒤에 전달했어요"}
      </span>
    </div>
  );
}

export function MessageView({
  message,
  streaming,
  awaitingApproval,
  tasks,
  traceConnection,
  readOnly,
  onResumeTask,
  onArchiveTask,
  onDeleteTask,
}: {
  message: UIMessage;
  streaming: boolean;
  /** Tool call ids with an approval card open. */
  awaitingApproval: readonly string[];
  tasks: readonly TraceTaskView[];
  traceConnection: TraceConnection;
  readOnly: boolean;
  onResumeTask: (task: TraceTaskView, confirmUncertain: boolean) => Promise<ResumeActionResult>;
  onArchiveTask: (task: TraceTaskView) => Promise<ArchiveActionResult>;
  onDeleteTask: (task: TraceTaskView) => Promise<DeleteActionResult>;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("");
    // Only our own attachments are shown; an image part pointing elsewhere is not loaded.
    const images = message.parts
      .flatMap((part) =>
        part.type === "image" && part.source.type === "url" && attachmentIdOf(part.source.value)
          ? [part.source.value]
          : [],
      )
      .map((url, index) => ({ number: index + 1, url }));
    return <UserMessageBody text={text} images={images} />;
  }

  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] flex-col gap-2 text-sm/relaxed">
        {message.parts.map((part, index) => {
          if (part.type === "text")
            return <Markdown key={`text-${index}`} text={part.content} streaming={streaming} />;
          if (part.type === "tool-call")
            return (
              <ToolCallView
                key={`tool-${part.id}`}
                call={part}
                result={message.parts.findLast(
                  (result): result is ToolResult =>
                    result.type === "tool-result" && result.toolCallId === part.id,
                )}
                awaitingApproval={awaitingApproval.includes(part.id)}
                task={taskForToolCall(tasks, part.id)}
                traceConnection={traceConnection}
                readOnly={readOnly}
                onResumeTask={onResumeTask}
                onArchiveTask={onArchiveTask}
                onDeleteTask={onDeleteTask}
              />
            );
          return null;
        })}
      </div>
    </div>
  );
}
