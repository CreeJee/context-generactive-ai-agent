import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { isTruthy } from "../../truthy.ts";
import { SchemaTransformation } from "effect";
import { Data, DateTime, Option, Schema } from "effect";
import { BotIcon, BrainIcon, Clock3Icon, WrenchIcon } from "lucide-react";
import type { TraceTaskView } from "memory-agent";
import type { HighlightOptions, HighlightResult } from "@streamdown/code";
import { Fragment, memo, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Bubble, BubbleContent } from "~/components/ui/bubble";
import { Button } from "~/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "~/components/ui/code-block";
import { Message, MessageContent, MessageHeader } from "~/components/ui/message";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "~/components/ui/trace";
import type { ChatMessage, MessagePart } from "memory-agent/chat-api";
import { attachmentIdOf, attachmentUrl, type QueuedMessage } from "memory-agent/definitions";
import { DrawingPicture, UserMessageBody } from "./images";
import { codeHighlighter, Markdown } from "./markdown";
import { failureLabel } from "../session/attempt-failure";
import { taskForToolCall, type TraceConnection } from "../session/work-trace";

type ToolCall = (typeof MessagePart.cases)["tool-call"]["Type"];
type ToolResult = (typeof MessagePart.cases)["tool-result"]["Type"];

const toolLabels = {
  find_memory: msg`기억 검색`,
  read_evidence: msg`원문 읽기`,
  trace_evidence: msg`근거 추적`,
  list_files: msg`파일 목록`,
  search_files: msg`파일 내용 검색`,
  read_file: msg`파일 읽기`,
  write_file: msg`파일 쓰기`,
  edit_file: msg`파일 편집`,
  delete_file: msg`파일 삭제`,
  list_outside_files: msg`프로젝트 밖 파일 목록`,
  read_outside_file: msg`프로젝트 밖 파일 읽기`,
  search_outside_file: msg`프로젝트 밖 파일 검색`,
  // Calls recorded before shell skills replaced it.
  run_shell: msg`셸 실행`,
  // Calls recorded before code skills replaced it.
  save_shell_skill: msg`셸 스킬 저장`,
  save_code_skill: msg`코드 스킬 저장`,
  run_skill: msg`코드 스킬 실행`,
  run_code: msg`코드 실행`,
  write_outside_file: msg`프로젝트 밖 파일 쓰기`,
  delete_outside_file: msg`프로젝트 밖 파일 삭제`,
  kagi_search: msg`웹 검색`,
  kagi_extract: msg`웹 페이지 읽기`,
  read_skill: msg`skill 읽기`,
  run_subagent: msg`서브에이전트 실행`,
  // Calls recorded before run_subagent took a helper name.
  message_subagent: msg`서브에이전트에게 메시지 보내기`,
  delegate_to_agent: msg`외부 에이전트에게 맡기기`,
  // Calls TanStack recorded to load a tool sent by name only.
  __lazy__tool__discovery__: msg`도구 불러오기`,
} satisfies Record<string, MessageDescriptor>;

/** Built-in tools by their label; MCP tools (`mcp_<server>__<tool>`) as "MCP server · tool". */
function ToolLabel({ name }: { readonly name: string }) {
  const { t } = useLingui();
  const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  const builtIn = Object.entries(toolLabels).find(([tool]) => tool === name)?.[1];
  return builtIn !== undefined ? t(builtIn) : isTruthy(mcp) ? `MCP ${mcp[1]} · ${mcp[2]}` : name;
}

declare module "react" {
  interface CSSProperties {
    /** A highlighted token's colors; the `code-token` utility picks one for the theme. */
    readonly "--token-light"?: string;
    readonly "--token-dark"?: string;
  }
}

type HighlightLanguage = HighlightOptions["language"];

/** Tool text as shown, and the language it is highlighted as; null leaves it plain. */
interface ToolText {
  readonly value: string;
  readonly language: HighlightLanguage | null;
}

/** JSON indented and highlighted as JSON, anything else plain as it came. */
function pretty(text: string): ToolText {
  try {
    return { value: JSON.stringify(JSON.parse(text), null, 2), language: "json" };
  } catch {
    return { value: text, language: null };
  }
}

/**
 * Shiki tokens for `text` from the highlighter answers use. Null for plain text, and until the
 * language has loaded.
 */
function useHighlight(text: string, language: HighlightLanguage | null) {
  const [highlighted, setHighlighted] = useState<{
    readonly text: string;
    readonly result: HighlightResult;
  } | null>(null);
  useEffect(() => {
    if (language === null) return;
    const ready = codeHighlighter.highlight(
      { code: text, language, themes: codeHighlighter.getThemes() },
      (result) => setHighlighted({ text, result }),
    );
    if (ready !== null) setHighlighted({ text, result: ready });
  }, [text, language]);
  return highlighted?.text === text ? highlighted.result : null;
}

/** A tool call's arguments or result in a code block that can be copied. */
function ToolCode({ title, text, failed }: { title: ReactNode; text: string; failed: boolean }) {
  const { t } = useLingui();
  const { value, language } = pretty(text);
  const highlighted = useHighlight(value, language);
  return (
    <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            value={value}
            aria-label={t({
              message: "복사",
              comment: "Button that copies a tool call's code block",
            })}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-64">
        {highlighted === null
          ? value
          : highlighted.tokens.map((line, index) => (
              <CodeBlockLine key={index}>
                {line.map((token, at) => {
                  // Shiki puts the light color in `color` and the dark one in `--shiki-dark`.
                  const light = token.htmlStyle?.color ?? token.color;
                  return (
                    <span
                      key={at}
                      className="code-token"
                      style={{
                        "--token-light": light,
                        "--token-dark": token.htmlStyle?.["--shiki-dark"] ?? light,
                      }}
                    >
                      {token.content}
                    </span>
                  );
                })}
              </CodeBlockLine>
            ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** Where a tool call stands, as the badge shows it. */
type CallStatus = Data.TaggedEnum<{
  running: {};
  "awaiting-approval": {};
  completed: {};
  failed: {};
  denied: {};
  blocked: {};
}>;
const CallStatus = Data.taggedEnum<CallStatus>();

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
      error: Schema.String.pipe(
        Schema.check(Schema.isStartingWith("blocked_by_permission_review")),
      ),
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
const refusalStatus = {
  denied: CallStatus.denied(),
  blocked: CallStatus.blocked(),
} satisfies Record<typeof RefusedResult.Type, CallStatus>;

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
  if (!isTruthy(result)) return null;
  const drawing = Option.getOrUndefined(decodeDrawing(result.content));
  if (!(drawing !== undefined)) return null;
  const url = attachmentUrl(drawing.preview.attachmentId);
  return isTruthy(attachmentIdOf(url)) ? { url, path: drawing.path } : null;
}

function callStatus(call: ToolCall, result: ToolResult | undefined, awaitingApproval: boolean) {
  if (!isTruthy(result))
    return awaitingApproval || call.state === "approval-requested"
      ? CallStatus["awaiting-approval"]()
      : CallStatus.running();
  const refusal = Option.getOrUndefined(decodeRefusal(result.content));
  if (isTruthy(refusal)) return refusalStatus[refusal];
  return result.state === "error" ? CallStatus.failed() : CallStatus.completed();
}

/** How a call's trace row looks: its line status, and a word unless the call simply finished. */
interface CallTrace {
  readonly line: ComponentProps<typeof TraceLine>["status"];
  readonly label: MessageDescriptor | null;
}

const callTrace = CallStatus.$match({
  running: (): CallTrace => ({
    line: "running",
    label: msg({ message: "실행 중", comment: "Status of a tool call in the chat trace" }),
  }),
  "awaiting-approval": (): CallTrace => ({
    line: undefined,
    label: msg({ message: "승인 대기", comment: "Status of a tool call in the chat trace" }),
  }),
  completed: (): CallTrace => ({ line: undefined, label: null }),
  failed: (): CallTrace => ({
    line: "error",
    label: msg({ message: "실패", comment: "Status of a tool call in the chat trace" }),
  }),
  denied: (): CallTrace => ({
    line: "error",
    label: msg({
      message: "거부됨",
      comment: "Status of a tool call the user declined to approve",
    }),
  }),
  blocked: (): CallTrace => ({ line: "error", label: msg`자동 검토로 막힘` }),
});

const activeTaskStatuses: readonly TraceTaskView["status"][] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "resuming",
];

/** How long a task has run, or ran, in short Korean units. */
export function elapsed(task: TraceTaskView): ReactNode {
  const milliseconds = Math.max(
    0,
    (activeTaskStatuses.includes(task.status)
      ? DateTime.toEpochMillis(DateTime.nowUnsafe())
      : task.updatedAt) - task.createdAt,
  );
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return <Trans comment="How long a task has run, in seconds">{seconds}초</Trans>;
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  return minutes < 60 ? (
    <Trans comment="How long a task has run, in minutes">{minutes}분</Trans>
  ) : (
    <Trans comment="How long a task has run, in hours">{hours}시간</Trans>
  );
}

function taskStatus(task: TraceTaskView) {
  switch (task.status) {
    case "queued":
      return {
        label: msg({ message: "대기 중", comment: "Status badge on a subagent task card" }),
        variant: "outline" as const,
      };
    case "running":
      return {
        label: msg({ message: "실행 중", comment: "Status badge on a subagent task card" }),
        variant: "outline" as const,
      };
    case "waiting":
      return {
        label: msg({ message: "승인 대기", comment: "Status badge on a subagent task card" }),
        variant: "outline" as const,
      };
    case "blocked":
      return {
        label: msg({ message: "확인 필요", comment: "Status badge on a subagent task card" }),
        variant: "destructive" as const,
      };
    case "interrupted":
      return {
        label: msg({ message: "중단됨", comment: "Status badge on a subagent task card" }),
        variant: "destructive" as const,
      };
    case "resumable":
      return {
        label: msg({ message: "다시 시도 가능", comment: "Status badge on a subagent task card" }),
        variant: "destructive" as const,
      };
    case "resuming":
      return {
        label: msg({
          message: "새 실행으로 다시 시도 중",
          comment: "Status badge on a subagent task card",
        }),
        variant: "outline" as const,
      };
    case "completed":
      return {
        label: msg({ message: "완료", comment: "Status badge on a subagent task card" }),
        variant: "secondary" as const,
      };
    case "failed":
      return {
        label: msg({ message: "실패", comment: "Status badge on a subagent task card" }),
        variant: "destructive" as const,
      };
    case "cancelled":
      return {
        label: msg({ message: "중단됨", comment: "Status badge on a subagent task card" }),
        variant: "destructive" as const,
      };
    case "archived":
      return {
        label: msg({ message: "보관됨", comment: "Status badge on a subagent task card" }),
        variant: "secondary" as const,
      };
    case "deleted":
      return {
        label: msg({ message: "삭제됨", comment: "Status badge on a subagent task card" }),
        variant: "secondary" as const,
      };
  }
}

export type ResumeActionResult = Data.TaggedEnum<{
  queued: {};
  blocked: { readonly reason: string };
  failed: {};
}>;
export const ResumeActionResult = Data.taggedEnum<ResumeActionResult>();
export type ArchiveActionResult = Data.TaggedEnum<{
  archived: {};
  blocked: { readonly reason: string };
  failed: {};
}>;
export const ArchiveActionResult = Data.taggedEnum<ArchiveActionResult>();
export type DeleteActionResult = Data.TaggedEnum<{
  deleted: {};
  blocked: { readonly reason: string };
  failed: {};
}>;
export const DeleteActionResult = Data.taggedEnum<DeleteActionResult>();
/** A subagent task that ended without completing can be rerun as a new attempt. */
const retryableTaskStatuses: readonly TraceTaskView["status"][] = [
  "blocked",
  "interrupted",
  "resumable",
  "failed",
  "cancelled",
];
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

const TaskSummaryCard = memo(function TaskSummaryCard({
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
  const { t } = useLingui();
  const { title } = task;
  const status = taskStatus(task);
  const active = activeTaskStatuses.includes(task.status);
  const [resumeState, setResumeState] = useState<
    "idle" | "requesting" | "confirm-uncertain" | "queued" | "failed"
  >("idle");
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const resume = (confirmUncertain: boolean) =>
    runUiEffect(
      Effect.gen(function* () {
        setResumeState("requesting");
        const result = yield* uiPromise(() => onResume(task, confirmUncertain));
        ResumeActionResult.$match(result, {
          queued: () => setResumeState("queued"),
          blocked: ({ reason }) =>
            setResumeState(reason === "uncertain_side_effect" ? "confirm-uncertain" : "failed"),
          failed: () => setResumeState("failed"),
        });
      }),
    );
  const [archiveState, setArchiveState] = useState<"idle" | "requesting" | "failed">("idle");
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const archive = () =>
    runUiEffect(
      Effect.gen(function* () {
        setArchiveState("requesting");
        const result = yield* uiPromise(() => onArchive(task));
        setArchiveState(ArchiveActionResult.$is("archived")(result) ? "idle" : "failed");
      }),
    );
  const [deleteState, setDeleteState] = useState<"idle" | "requesting" | "failed">("idle");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const remove = () =>
    runUiEffect(
      Effect.gen(function* () {
        setConfirmingDelete(false);
        setDeleteState("requesting");
        const result = yield* uiPromise(() => onDelete(task));
        setDeleteState(DeleteActionResult.$is("deleted")(result) ? "idle" : "failed");
      }),
    );
  const openTrace = () =>
    window.dispatchEvent(new CustomEvent("work-trace:open", { detail: { taskId: task.id } }));
  return (
    <section
      className="min-w-72 rounded-lg border bg-muted/30 p-3"
      aria-label={t`서브에이전트 작업: ${title}`}
    >
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{task.agentName ?? t`서브에이전트`}</span>
        <Badge className="ml-auto shrink-0" variant={status.variant}>
          {t(status.label)}
        </Badge>
      </div>
      <p className="mt-2 line-clamp-2 text-sm">{task.request}</p>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3Icon className="size-3.5" aria-hidden />
        <span>{elapsed(task)}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">
          {active && connection !== "live" ? (
            <Trans>실행 상태에 다시 연결 중</Trans>
          ) : (
            (task.heartbeat?.step ?? <Trans>작업 기록을 준비하는 중</Trans>)
          )}
        </span>
      </div>
      {task.latestFailure !== null && (
        <p className="mt-1 text-xs text-destructive" role="status">
          {failureLabel(task.latestFailure)}
        </p>
      )}
      {task.latestResumedFromAttemptId && (
        <p className="mt-1 text-xs text-muted-foreground">
          <Trans>이전 실행을 새 attempt로 다시 시도함</Trans>
        </p>
      )}
      {task.status === "resumable" && (
        <p className="mt-1 text-xs text-destructive">
          <Trans>실행이 중단됐습니다. 작업을 새 attempt로 다시 시도할 수 있습니다.</Trans>
        </p>
      )}
      {resumeState === "confirm-uncertain" && (
        <p className="mt-1 text-xs text-destructive">
          <Trans>
            완료 여부가 불확실한 도구가 있습니다. 중복 side effect 가능성을 확인해야 합니다.
          </Trans>
        </p>
      )}
      {resumeState === "failed" && (
        <p className="mt-1 text-xs text-destructive">
          <Trans>최신 상태에서 다시 시도할 수 없습니다.</Trans>
        </p>
      )}
      <div className="mt-2 flex items-center justify-end gap-1">
        {retryableTaskStatuses.includes(task.status) &&
          task.agentId !== null &&
          task.latestAttemptId && (
            <Button
              type="button"
              size="sm"
              variant={resumeState === "confirm-uncertain" ? "destructive" : "outline"}
              disabled={readOnly || resumeState === "requesting" || resumeState === "queued"}
              onClick={() => void resume(resumeState === "confirm-uncertain")}
            >
              {resumeState === "requesting" ? (
                <Trans comment="Retry button while the retry request is being sent">요청 중</Trans>
              ) : resumeState === "queued" ? (
                <Trans comment="Retry button after the retry was queued">다시 시도 요청됨</Trans>
              ) : resumeState === "confirm-uncertain" ? (
                <Trans>위험 확인 후 다시 시도</Trans>
              ) : (
                <Trans comment="Button that reruns a subagent task as a new attempt">
                  다시 시도
                </Trans>
              )}
            </Button>
          )}
        {archivableTaskStatuses.includes(task.status) && (
          <Button
            type="button"
            size="sm"
            variant="ghost-muted"
            disabled={readOnly || archiveState === "requesting"}
            onClick={() => void archive()}
          >
            {archiveState === "requesting" ? (
              <Trans comment="Archive button while the task is being archived">보관 중</Trans>
            ) : archiveState === "failed" ? (
              <Trans comment="Archive button after archiving failed">보관 재시도</Trans>
            ) : (
              <Trans comment="Button that archives a subagent task">보관</Trans>
            )}
          </Button>
        )}
        {task.status !== "deleted" && (
          <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  disabled={readOnly || deleteState === "requesting"}
                />
              }
            >
              {deleteState === "requesting" ? (
                <Trans comment="Delete button while the task record is being deleted">
                  삭제 중
                </Trans>
              ) : deleteState === "failed" ? (
                <Trans comment="Delete button after deleting failed">삭제 재시도</Trans>
              ) : (
                <Trans comment="Button that deletes a subagent task's record">삭제</Trans>
              )}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>이 작업의 기록을 삭제할까요?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    transcript와 locator를 지웁니다. 채택된 project memory와 provenance는
                    유지됩니다.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans comment="Dialog button that keeps the task record">취소</Trans>
                </AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                  <Trans comment="Dialog button that deletes the task record">삭제</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button type="button" size="sm" variant="ghost-muted" onClick={openTrace}>
          <Trans>Work Trace에서 보기</Trans>
        </Button>
      </div>
    </section>
  );
});

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
      {task !== undefined ? (
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

const ToolCallCard = memo(function ToolCallCard({
  call,
  result,
  awaitingApproval,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  awaitingApproval: boolean;
}) {
  const { t } = useLingui();
  const { line, label } = callTrace(callStatus(call, result, awaitingApproval));
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={line}>
          <TraceIcon>
            <WrenchIcon />
          </TraceIcon>
          <TraceTitle>
            <ToolLabel name={call.name} />
          </TraceTitle>
          {label !== null && <TraceDescription>{t(label)}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-2">
          <ToolCode
            title={
              <>
                <Trans comment="Title of the code block with a tool call's arguments">인자</Trans> ·{" "}
                <code>{call.name}</code>
              </>
            }
            text={call.arguments}
            failed={false}
          />
          {result && (
            <ToolCode
              title={
                <Trans comment="Title of the code block with a tool call's result">결과</Trans>
              }
              text={result.content}
              failed={result.state === "error"}
            />
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

/**
 * A message the running answer took in (steered, or at a tool call). It shows where the saved
 * conversation will have it, until the run ends and the conversation is read again.
 */
export function DeliveredMessageView({ message }: { message: QueuedMessage }) {
  const images = message.attachmentIds.map((id, index) => ({
    number: index + 1,
    url: attachmentUrl(id),
  }));
  return <UserMessageBody text={message.text} images={images} />;
}

type MessageViewProps = {
  message: ChatMessage;
  streaming: boolean;
  /** Tool call ids with an approval card open. */
  awaitingApproval: readonly string[];
  tasks: readonly TraceTaskView[];
  traceConnection: TraceConnection;
  readOnly: boolean;
  onResumeTask: (task: TraceTaskView, confirmUncertain: boolean) => Promise<ResumeActionResult>;
  onArchiveTask: (task: TraceTaskView) => Promise<ArchiveActionResult>;
  onDeleteTask: (task: TraceTaskView) => Promise<DeleteActionResult>;
};

/**
 * Whether a message would show the same. The approval and task lists belong to the whole session,
 * so only what this message's own tool calls read from them counts.
 */
const sameMessageView = (previous: MessageViewProps, next: MessageViewProps) =>
  previous.message === next.message &&
  previous.streaming === next.streaming &&
  previous.traceConnection === next.traceConnection &&
  previous.readOnly === next.readOnly &&
  previous.onResumeTask === next.onResumeTask &&
  previous.onArchiveTask === next.onArchiveTask &&
  previous.onDeleteTask === next.onDeleteTask &&
  next.message.parts.every(
    (part) =>
      part.type !== "tool-call" ||
      (previous.awaitingApproval.includes(part.id) === next.awaitingApproval.includes(part.id) &&
        taskForToolCall(previous.tasks, part.id) === taskForToolCall(next.tasks, part.id)),
  );

type OrchestratorMessage = Extract<ChatMessage, { readonly role: "orchestrator" }>;

const nextLabels = {
  results: msg`결과 확인`,
  plan: msg`Plan 이어서 진행`,
  board: msg`칸반 보드 확인`,
  run: msg`진행 중인 작업에 알림`,
} satisfies Record<OrchestratorMessage["note"]["next"], MessageDescriptor>;

/**
 * A message the orchestrator sent to start a run in the user's stead, or to tell the run in
 * progress how its tasks went. It sits where the user's messages do, in a color of its own, under
 * the orchestrator's name.
 */
const OrchestratorMessageView = ({ message }: { readonly message: OrchestratorMessage }) => {
  const { t } = useLingui();
  const { next, ended } = message.note;
  const { background: backgroundCount, subagent: subagentCount } = ended;
  // What the orchestrator's message says, in the UI's words.
  const summary = [
    ...(backgroundCount > 0 ? [t`백그라운드 작업 ${backgroundCount}개 끝남`] : []),
    ...(subagentCount > 0 ? [t`서브에이전트 ${subagentCount}개 끝남`] : []),
    t(nextLabels[next]),
  ].join(", ");
  return (
    <Message align="end">
      <MessageContent>
        <MessageHeader>
          <Trans>오케스트레이터</Trans>
        </MessageHeader>
        <Bubble variant="secondary">
          <BubbleContent>{summary}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
};

/**
 * One chat message. Assistant text renders as Markdown (`streaming` while it is still arriving);
 * user text stays exactly as typed, and the orchestrator's message says why it started a run. Tool
 * calls show what was looked up and what came back. A streaming answer renders only itself: the
 * other messages keep their render unless something they show changed.
 */
export const MessageView = memo(function MessageView({
  message,
  streaming,
  awaitingApproval,
  tasks,
  traceConnection,
  readOnly,
  onResumeTask,
  onArchiveTask,
  onDeleteTask,
}: MessageViewProps) {
  if (message.role === "orchestrator") return <OrchestratorMessageView message={message} />;

  const isUser = message.role === "user";

  if (isUser) {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("");
    // Only our own attachments are shown; an image part pointing elsewhere is not loaded.
    const images = message.parts
      .flatMap((part) =>
        part.type === "image" &&
        part.source.type === "url" &&
        isTruthy(attachmentIdOf(part.source.value))
          ? [part.source.value]
          : [],
      )
      .map((url, index) => ({ number: index + 1, url }));
    return <UserMessageBody text={text} images={images} />;
  }

  /**
   * Thinking and tool calls in a row form one trace block, its lines close together; text and a
   * subagent's task card stand apart from it at the message's own gap.
   */
  const blocks = message.parts.reduce<Array<{ trace: boolean; indexes: number[] }>>(
    (groups, part, index) => {
      const trace =
        part.type === "thinking" ||
        (part.type === "tool-call" && taskForToolCall(tasks, part.id) === undefined);
      const last = groups.at(-1);
      if (trace && last?.trace === true) last.indexes.push(index);
      else groups.push({ trace, indexes: [index] });
      return groups;
    },
    [],
  );
  const renderPart = (part: (typeof message.parts)[number], index: number): ReactNode => {
    if (part.type === "thinking") {
      const thinking = streaming && index === message.parts.length - 1;
      return (
        <TraceCollapsible key={`thinking-${index}`}>
          <TraceCollapsibleTrigger>
            <TraceLine status={thinking ? "running" : undefined}>
              <TraceIcon>
                <BrainIcon />
              </TraceIcon>
              <TraceTitle>
                {thinking ? (
                  <Trans comment="Title of the model's reasoning while it is still thinking">
                    추론 중
                  </Trans>
                ) : (
                  <Trans comment="Title of the model's finished reasoning">추론 내용</Trans>
                )}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <p className="max-h-80 overflow-auto whitespace-pre-wrap">{part.content}</p>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    }
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
  };

  return (
    <Message>
      <MessageContent>
        <div className="flex min-w-0 flex-col gap-3">
          {blocks.map(({ trace, indexes }) => {
            const parts = indexes.flatMap((index) => {
              const part = message.parts[index];
              return part === undefined ? [] : [renderPart(part, index)];
            });
            return trace ? (
              <Trace key={`trace-${indexes[0]}`}>{parts}</Trace>
            ) : (
              <Fragment key={`part-${indexes[0]}`}>{parts}</Fragment>
            );
          })}
        </div>
      </MessageContent>
    </Message>
  );
}, sameMessageView);
