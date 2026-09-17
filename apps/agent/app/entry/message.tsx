import type { UIMessage } from "@tanstack/ai-react";
import { Option, Schema } from "effect";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { attachmentIdOf, attachmentUrl } from "memory-agent/definitions";
import { DrawingPicture, UserMessageBody } from "./images";
import { Markdown } from "./markdown";

type Part = UIMessage["parts"][number];
type ToolCall = Extract<Part, { type: "tool-call" }>;
type ToolResult = Extract<Part, { type: "tool-result" }>;

const toolLabels = new Map([
  ["find_memory", "기억 검색"],
  ["read_evidence", "원문 읽기"],
  ["trace_evidence", "근거 추적"],
  ["list_files", "파일 목록"],
  ["search_files", "파일 내용 검색"],
  ["read_file", "파일 읽기"],
  ["write_file", "파일 쓰기"],
  ["edit_file", "파일 편집"],
  ["delete_file", "파일 삭제"],
  ["list_outside_files", "프로젝트 밖 파일 목록"],
  ["read_outside_file", "프로젝트 밖 파일 읽기"],
  ["search_outside_file", "프로젝트 밖 파일 검색"],
  ["run_shell", "셸 실행"],
  ["write_outside_file", "프로젝트 밖 파일 쓰기"],
  ["delete_outside_file", "프로젝트 밖 파일 삭제"],
  ["kagi_search", "웹 검색"],
  ["kagi_extract", "웹 페이지 읽기"],
  ["read_skill", "skill 읽기"],
  ["run_subagent", "서브에이전트 실행"],
  ["message_subagent", "서브에이전트에게 메시지 보내기"],
  ["delegate_to_agent", "외부 에이전트에게 맡기기"],
]);

/** Built-in tools by their label; MCP tools (`mcp_<server>__<tool>`) as "MCP server · tool". */
function toolLabel(name: string) {
  const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  return toolLabels.get(name) ?? (mcp ? `MCP ${mcp[1]} · ${mcp[2]}` : name);
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
const RefusedResult = Schema.Union(
  Schema.transform(
    Schema.parseJson(Schema.Struct({ approved: Schema.Literal(false) })),
    Schema.Literal("denied"),
    { strict: true, decode: () => "denied" as const, encode: () => ({ approved: false as const }) },
  ),
  Schema.transform(
    Schema.parseJson(
      Schema.Struct({
        error: Schema.String.pipe(Schema.startsWith("blocked_by_permission_review")),
      }),
    ),
    Schema.Literal("blocked"),
    {
      strict: true,
      decode: () => "blocked" as const,
      encode: () => ({ error: "blocked_by_permission_review" }),
    },
  ),
);
const decodeRefusal = Schema.decodeUnknownOption(RefusedResult);

/** A write_file / edit_file result that carries a picture of the SVG it wrote. */
const decodeDrawing = Schema.decodeUnknownOption(
  Schema.parseJson(
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

function ToolCallView({
  call,
  result,
  awaitingApproval,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  awaitingApproval: boolean;
}) {
  const drawing = drawingOf(result);
  return (
    <div className="flex flex-col gap-1.5">
      <ToolCallCard call={call} result={result} awaitingApproval={awaitingApproval} />
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
export function MessageView({
  message,
  streaming,
  awaitingApproval,
}: {
  message: UIMessage;
  streaming: boolean;
  /** Tool call ids with an approval card open. */
  awaitingApproval: ReadonlySet<string>;
}) {
  const results = new Map(
    message.parts.flatMap((part) =>
      part.type === "tool-result" ? [[part.toolCallId, part] as const] : [],
    ),
  );
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
            return <Markdown key={index} text={part.content} streaming={streaming} />;
          if (part.type === "tool-call")
            return (
              <ToolCallView
                key={part.id}
                call={part}
                result={results.get(part.id)}
                awaitingApproval={awaitingApproval.has(part.id)}
              />
            );
          return null;
        })}
      </div>
    </div>
  );
}
