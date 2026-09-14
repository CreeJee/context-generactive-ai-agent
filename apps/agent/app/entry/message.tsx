import type { UIMessage } from "@tanstack/ai-react";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

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
  ["list_outside_files", "밖 파일 목록"],
  ["read_outside_file", "밖 파일 읽기"],
  ["search_outside_file", "밖 파일 검색"],
  ["run_shell", "셸 실행"],
  ["write_outside_file", "밖 파일 쓰기"],
  ["delete_outside_file", "밖 파일 삭제"],
]);

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

function ToolCallView({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const failed = result?.state === "error" || call.approval?.approved === false;
  const status = failed
    ? "실패"
    : result
      ? "완료"
      : call.state === "approval-requested"
        ? "승인 대기"
        : "실행 중";
  return (
    <Collapsible className="rounded-md border bg-muted/30 text-xs">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{toolLabels.get(call.name) ?? call.name}</span>
        <code className="text-muted-foreground">{call.name}</code>
        <Badge
          variant={failed ? "destructive" : result ? "secondary" : "outline"}
          className="ml-auto"
        >
          {call.approval?.approved === false ? "거부됨" : status}
        </Badge>
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

/** One chat message. Tool calls show what the model looked up and exactly what came back. */
export function MessageView({ message }: { message: UIMessage }) {
  const results = new Map(
    message.parts.flatMap((part) =>
      part.type === "tool-result" ? [[part.toolCallId, part] as const] : [],
    ),
  );
  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-2 text-sm/relaxed",
          isUser && "rounded-2xl bg-primary px-3.5 py-2 text-primary-foreground",
        )}
      >
        {message.parts.map((part, index) => {
          if (part.type === "text")
            return (
              <p key={index} className="whitespace-pre-wrap">
                {part.content}
              </p>
            );
          if (part.type === "tool-call")
            return <ToolCallView key={part.id} call={part} result={results.get(part.id)} />;
          return null;
        })}
      </div>
    </div>
  );
}
