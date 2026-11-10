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
import { chatCopy } from "./copy";

type ToolCall = (typeof MessagePart.cases)["tool-call"]["Type"];
type ToolResult = (typeof MessagePart.cases)["tool-result"]["Type"];

const copy = chatCopy.message;

const toolLabels = copy.toolLabels satisfies Record<string, string>;

/** Built-in tools by their label; MCP tools (`mcp_<server>__<tool>`) as "MCP server · tool". */
function toolLabel(name: string) {
  const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  return (
    Object.entries(toolLabels).find(([tool]) => tool === name)?.[1] ??
    (isTruthy(mcp) ? `MCP ${mcp[1]} · ${mcp[2]}` : name)
  );
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
  const { value, language } = pretty(text);
  const highlighted = useHighlight(value, language);
  return (
    <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={value} aria-label={copy.copy} />
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
  readonly label: string | null;
}

const callTrace = CallStatus.$match({
  running: (): CallTrace => ({ line: "running", label: copy.call.running }),
  "awaiting-approval": (): CallTrace => ({ line: undefined, label: copy.call.awaitingApproval }),
  completed: (): CallTrace => ({ line: undefined, label: null }),
  failed: (): CallTrace => ({ line: "error", label: copy.call.failed }),
  denied: (): CallTrace => ({ line: "error", label: copy.call.denied }),
  blocked: (): CallTrace => ({ line: "error", label: copy.call.blocked }),
});

const activeTaskStatuses: readonly TraceTaskView["status"][] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "resuming",
];

/** How long a task has run, or ran, in short Korean units. */
export function elapsed(task: TraceTaskView) {
  const milliseconds = Math.max(
    0,
    (activeTaskStatuses.includes(task.status)
      ? DateTime.toEpochMillis(DateTime.nowUnsafe())
      : task.updatedAt) - task.createdAt,
  );
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return copy.seconds(Math.max(1, seconds));
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? copy.minutes(minutes) : copy.hours(Math.round(minutes / 60));
}

function taskStatus(task: TraceTaskView) {
  switch (task.status) {
    case "queued":
      return { label: copy.taskStatus.queued, variant: "outline" as const };
    case "running":
      return { label: copy.taskStatus.running, variant: "outline" as const };
    case "waiting":
      return { label: copy.taskStatus.waiting, variant: "outline" as const };
    case "blocked":
      return { label: copy.taskStatus.blocked, variant: "destructive" as const };
    case "interrupted":
      return { label: copy.taskStatus.interrupted, variant: "destructive" as const };
    case "resumable":
      return { label: copy.taskStatus.resumable, variant: "destructive" as const };
    case "resuming":
      return { label: copy.taskStatus.resuming, variant: "outline" as const };
    case "completed":
      return { label: copy.taskStatus.completed, variant: "secondary" as const };
    case "failed":
      return { label: copy.taskStatus.failed, variant: "destructive" as const };
    case "cancelled":
      return { label: copy.taskStatus.cancelled, variant: "destructive" as const };
    case "archived":
      return { label: copy.taskStatus.archived, variant: "secondary" as const };
    case "deleted":
      return { label: copy.taskStatus.deleted, variant: "secondary" as const };
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
      aria-label={copy.subagentTask(task.title)}
    >
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{task.agentName ?? copy.subagent}</span>
        <Badge className="ml-auto shrink-0" variant={status.variant}>
          {status.label}
        </Badge>
      </div>
      <p className="mt-2 line-clamp-2 text-sm">{task.request}</p>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3Icon className="size-3.5" aria-hidden />
        <span>{elapsed(task)}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">
          {active && connection !== "live"
            ? copy.reconnecting
            : (task.heartbeat?.step ?? copy.preparing)}
        </span>
      </div>
      {task.latestFailure !== null && (
        <p className="mt-1 text-xs text-destructive" role="status">
          {failureLabel(task.latestFailure)}
        </p>
      )}
      {task.latestResumedFromAttemptId && (
        <p className="mt-1 text-xs text-muted-foreground">{copy.resumedAttempt}</p>
      )}
      {task.status === "resumable" && (
        <p className="mt-1 text-xs text-destructive">{copy.interrupted}</p>
      )}
      {resumeState === "confirm-uncertain" && (
        <p className="mt-1 text-xs text-destructive">{copy.uncertain}</p>
      )}
      {resumeState === "failed" && (
        <p className="mt-1 text-xs text-destructive">{copy.resumeFailed}</p>
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
              {resumeState === "requesting"
                ? copy.retry.requesting
                : resumeState === "queued"
                  ? copy.retry.queued
                  : resumeState === "confirm-uncertain"
                    ? copy.retry.confirmUncertain
                    : copy.retry.idle}
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
            {archiveState === "requesting"
              ? copy.archive.requesting
              : archiveState === "failed"
                ? copy.archive.failed
                : copy.archive.idle}
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
              {deleteState === "requesting"
                ? copy.delete.requesting
                : deleteState === "failed"
                  ? copy.delete.failed
                  : copy.delete.idle}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.deleteConfirm.title}</AlertDialogTitle>
                <AlertDialogDescription>{copy.deleteConfirm.body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{copy.deleteConfirm.choices.cancel}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                  {copy.deleteConfirm.choices.delete}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button type="button" size="sm" variant="ghost-muted" onClick={openTrace}>
          {copy.openTrace}
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
  const { line, label } = callTrace(callStatus(call, result, awaitingApproval));
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={line}>
          <TraceIcon>
            <WrenchIcon />
          </TraceIcon>
          <TraceTitle>{toolLabel(call.name)}</TraceTitle>
          {label !== null && <TraceDescription>{label}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-2">
          <ToolCode
            title={
              <>
                {copy.arguments} · <code>{call.name}</code>
              </>
            }
            text={call.arguments}
            failed={false}
          />
          {result && (
            <ToolCode title={copy.result} text={result.content} failed={result.state === "error"} />
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

const nextLabels = copy.next satisfies Record<OrchestratorMessage["note"]["next"], string>;

/** What the orchestrator's message says, in the UI's words. */
const orchestratorSummary = ({ next, ended }: OrchestratorMessage["note"]) =>
  [
    ...(ended.background > 0 ? [copy.endedBackground(ended.background)] : []),
    ...(ended.subagent > 0 ? [copy.endedSubagents(ended.subagent)] : []),
    nextLabels[next],
  ].join(", ");

/**
 * A message the orchestrator sent to start a run in the user's stead, or to tell the run in
 * progress how its tasks went. It sits where the user's messages do, in a color of its own, under
 * the orchestrator's name.
 */
const OrchestratorMessageView = ({ message }: { readonly message: OrchestratorMessage }) => (
  <Message align="end">
    <MessageContent>
      <MessageHeader>{copy.orchestrator}</MessageHeader>
      <Bubble variant="secondary">
        <BubbleContent>{orchestratorSummary(message.note)}</BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
);

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
              <TraceTitle>{thinking ? copy.thinking : copy.reasoning}</TraceTitle>
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
