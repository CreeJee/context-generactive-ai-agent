import type { useChat } from "@tanstack/ai-react";
import { Option, Schema } from "effect";
import { FileWarningIcon, TerminalIcon } from "lucide-react";
import {
  DeleteOutsideFileInput,
  RunShellInput,
  WriteOutsideFileInput,
  type approvalToolDefinitions,
} from "memory-agent/definitions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

export type ApprovalTools = typeof approvalToolDefinitions;
type ChatInterrupt = ReturnType<typeof useChat<ApprovalTools>>["interrupts"][number];
type ApprovalInterrupt = Extract<ChatInterrupt, { kind: "tool-approval" }>;

export function isApproval(interrupt: ChatInterrupt): interrupt is ApprovalInterrupt {
  return interrupt.kind === "tool-approval";
}

const decodeShell = Schema.decodeUnknownOption(RunShellInput);
const decodeWrite = Schema.decodeUnknownOption(WriteOutsideFileInput);
const decodeDelete = Schema.decodeUnknownOption(DeleteOutsideFileInput);

/** Keeps a long file body readable in the card; the full text is what gets written. */
function preview(content: string) {
  const lines = content.split("\n");
  return lines.length > 20
    ? `${lines.slice(0, 20).join("\n")}\n… ${lines.length - 20}줄 더`
    : content;
}

const codeBlock = "overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all";

interface ApprovalView {
  readonly title: string;
  readonly reason: string | undefined;
  readonly shell: boolean;
  readonly body: React.ReactNode;
}

/** What the user is agreeing to, decoded from the call's arguments. */
function describe(interrupt: ApprovalInterrupt): ApprovalView {
  const args = interrupt.originalArgs;
  const shell = Option.getOrUndefined(
    interrupt.toolName === "run_shell" ? decodeShell(args) : Option.none(),
  );
  if (shell)
    return {
      title: "셸 명령을 실행할까요?",
      reason: shell.reason,
      shell: true,
      body: (
        <div className="flex flex-col gap-2">
          <pre className={codeBlock}>{shell.command}</pre>
          <div className="text-muted-foreground">
            실행 위치: <code>{shell.workdir ?? "."}</code> (프로젝트 기준)
          </div>
        </div>
      ),
    };
  const write = Option.getOrUndefined(
    interrupt.toolName === "write_outside_file" ? decodeWrite(args) : Option.none(),
  );
  if (write)
    return {
      title: "프로젝트 밖 파일을 쓸까요?",
      reason: write.reason,
      shell: false,
      body: (
        <div className="flex flex-col gap-2">
          <div>
            <code className="break-all">{write.path}</code>{" "}
            <Badge variant="outline">{write.expectedSha256 ? "덮어쓰기" : "새 파일"}</Badge>
          </div>
          <pre className={`max-h-60 ${codeBlock}`}>{preview(write.content)}</pre>
        </div>
      ),
    };
  const remove = Option.getOrUndefined(
    interrupt.toolName === "delete_outside_file" ? decodeDelete(args) : Option.none(),
  );
  if (remove)
    return {
      title: "프로젝트 밖 파일을 삭제할까요?",
      reason: remove.reason,
      shell: false,
      body: <code className="break-all">{remove.path}</code>,
    };
  return {
    title: `${interrupt.toolName} 실행을 승인할까요?`,
    reason: undefined,
    shell: false,
    body: <pre className={codeBlock}>{JSON.stringify(args, null, 2)}</pre>,
  };
}

/**
 * One pending approval. Approving runs exactly this call once; nothing is remembered for later
 * calls, and declining tells the model the user said no.
 */
export function ApprovalCard({ interrupt }: { interrupt: ApprovalInterrupt }) {
  const view = describe(interrupt);
  const Icon = view.shell ? TerminalIcon : FileWarningIcon;
  return (
    <Card size="sm" className="ring-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" />
          {view.title}
        </CardTitle>
        <CardDescription>
          {view.reason ? `이유: ${view.reason}` : "모델이 이유를 적지 않았어요."} 승인하면 이번 한
          번만 실행돼요.
        </CardDescription>
      </CardHeader>
      <CardContent>{view.body}</CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={() => interrupt.resolveInterrupt(true)}>
          승인
        </Button>
        <Button size="sm" variant="outline" onClick={() => interrupt.resolveInterrupt(false)}>
          거부
        </Button>
      </CardFooter>
    </Card>
  );
}
