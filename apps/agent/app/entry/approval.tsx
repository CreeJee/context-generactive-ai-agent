import { Option, Schema } from "effect";
import { FileWarningIcon, ShieldQuestionIcon, TerminalIcon } from "lucide-react";
import {
  DeleteOutsideFileInput,
  RunShellInput,
  WriteOutsideFileInput,
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
import type { PendingApproval } from "./pending-approval";

/** A gated call's arguments, decoded once by tool name into a union the card can switch on. */
type GatedCall =
  | { readonly tool: "run_shell"; readonly input: typeof RunShellInput.Type }
  | { readonly tool: "write_outside_file"; readonly input: typeof WriteOutsideFileInput.Type }
  | { readonly tool: "delete_outside_file"; readonly input: typeof DeleteOutsideFileInput.Type }
  | { readonly tool: "delegate_to_agent"; readonly agent: string; readonly task: string }
  | {
      readonly tool: "mcp";
      readonly server: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | { readonly tool: "unrecognized"; readonly name: string; readonly argumentsJson: string };

const decodeShell = Schema.decodeUnknownOption(Schema.parseJson(RunShellInput));
const decodeWrite = Schema.decodeUnknownOption(Schema.parseJson(WriteOutsideFileInput));
const decodeDelete = Schema.decodeUnknownOption(Schema.parseJson(DeleteOutsideFileInput));
const decodeDelegation = Schema.decodeUnknownOption(
  Schema.parseJson(Schema.Struct({ agent: Schema.String, task: Schema.String })),
);

function decodeCall(toolName: string, argumentsJson: string): GatedCall {
  const unrecognized: GatedCall = { tool: "unrecognized", name: toolName, argumentsJson };
  switch (toolName) {
    case "run_shell":
      return Option.match(decodeShell(argumentsJson), {
        onNone: () => unrecognized,
        onSome: (input) => ({ tool: "run_shell", input }),
      });
    case "write_outside_file":
      return Option.match(decodeWrite(argumentsJson), {
        onNone: () => unrecognized,
        onSome: (input) => ({ tool: "write_outside_file", input }),
      });
    case "delete_outside_file":
      return Option.match(decodeDelete(argumentsJson), {
        onNone: () => unrecognized,
        onSome: (input) => ({ tool: "delete_outside_file", input }),
      });
    case "delegate_to_agent":
      return Option.match(decodeDelegation(argumentsJson), {
        onNone: () => unrecognized,
        onSome: (input) => ({ tool: "delegate_to_agent", ...input }),
      });
    default: {
      // MCP tools are named mcp_<server>__<tool>.
      const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(toolName);
      return mcp
        ? { tool: "mcp", server: mcp[1] ?? "", name: mcp[2] ?? toolName, argumentsJson }
        : unrecognized;
    }
  }
}

/** Keeps a long file body readable in the card; the full text is what gets written. */
function preview(content: string) {
  const lines = content.split("\n");
  return lines.length > 20
    ? `${lines.slice(0, 20).join("\n")}\n… ${lines.length - 20}줄 더`
    : content;
}

const codeBlock = "overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all";

interface CallView {
  readonly title: string;
  readonly modelReason: string | undefined;
  readonly shell: boolean;
  readonly body: React.ReactNode;
}

/** What the user is agreeing to. */
function describe(call: GatedCall): CallView {
  switch (call.tool) {
    case "run_shell":
      return {
        title: "셸 명령을 실행할까요?",
        modelReason: call.input.reason,
        shell: true,
        body: (
          <div className="flex flex-col gap-2">
            <pre className={codeBlock}>{call.input.command}</pre>
            <div className="text-muted-foreground">
              실행 위치: <code>{call.input.workdir ?? "."}</code> (
              {call.input.workdir?.startsWith("/") ? "임시 경로" : "프로젝트 기준"})
            </div>
          </div>
        ),
      };
    case "write_outside_file":
      return {
        title: "프로젝트 밖 파일을 쓸까요?",
        modelReason: call.input.reason,
        shell: false,
        body: (
          <div className="flex flex-col gap-2">
            <div>
              <code className="break-all">{call.input.path}</code>{" "}
              <Badge variant="outline">{call.input.expectedSha256 ? "덮어쓰기" : "새 파일"}</Badge>
            </div>
            <pre className={`max-h-60 ${codeBlock}`}>{preview(call.input.content)}</pre>
          </div>
        ),
      };
    case "delete_outside_file":
      return {
        title: "프로젝트 밖 파일을 삭제할까요?",
        modelReason: call.input.reason,
        shell: false,
        body: <code className="break-all">{call.input.path}</code>,
      };
    case "delegate_to_agent":
      return {
        title: `외부 에이전트 ${call.agent}에게 작업을 맡길까요?`,
        modelReason: undefined,
        shell: false,
        body: (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground">
              에이전트는 이 프로젝트에서 자기 도구로 일하고, 필요한 권한은 따로 물어요.
            </div>
            <pre className={`max-h-60 ${codeBlock}`}>{preview(call.task)}</pre>
          </div>
        ),
      };
    case "mcp":
      return {
        title: `MCP 도구 ${call.name} 실행을 승인할까요?`,
        modelReason: undefined,
        shell: false,
        body: (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground">
              서버: <code>{call.server}</code>
            </div>
            <pre className={`max-h-60 ${codeBlock}`}>{preview(call.argumentsJson)}</pre>
          </div>
        ),
      };
    case "unrecognized":
      return {
        title: `${call.name} 실행을 승인할까요?`,
        modelReason: undefined,
        shell: false,
        body: <pre className={codeBlock}>{call.argumentsJson}</pre>,
      };
  }
}

/** One pending approval for a shell run or outside write. Approving runs exactly this call once. */
export function ApprovalCard({
  approval,
  disabled,
  requester,
  decision,
  onAnswer,
}: {
  approval: PendingApproval;
  /** A read-only page shows the request but cannot answer it. */
  disabled: boolean;
  /** Who asks, when it is not the conversation's own agent (a subagent). */
  requester?: string;
  /** A decision staged for an atomic TanStack interrupt batch. */
  decision?: boolean;
  /** Stages a decision instead of resolving this interrupt immediately. */
  onAnswer?: (approved: boolean) => void;
}) {
  const view = describe(decodeCall(approval.toolName, approval.argumentsJson));
  const reviewReason =
    approval.kind === "permission-review" && approval.askedBy === "review"
      ? approval.reviewReason
      : null;
  const Icon = reviewReason ? ShieldQuestionIcon : view.shell ? TerminalIcon : FileWarningIcon;
  return (
    <Card size="sm" variant="warning">
      <CardHeader>
        <CardTitle className="flex items-center">
          <Icon className="mr-2 size-4" />
          {requester ? `${requester}: ${view.title}` : view.title}
        </CardTitle>
        <CardDescription className="flex flex-col">
          {reviewReason && <span className="mb-0.5">자동 검토: {reviewReason}</span>}
          <span>
            {view.modelReason
              ? `모델이 밝힌 이유: ${view.modelReason}`
              : "모델이 이유를 적지 않았어요."}{" "}
            승인하면 이번 한 번만 실행돼요.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>{view.body}</CardContent>
      <CardFooter>
        <Button
          size="sm"
          variant={decision === true ? "default" : "outline"}
          disabled={disabled}
          aria-pressed={decision === true}
          onClick={() => (onAnswer ?? approval.answer)(true)}
        >
          {decision === true ? "승인 선택됨" : "승인"}
        </Button>
        <Button
          size="sm"
          variant={decision === false ? "destructive" : "outline"}
          disabled={disabled}
          aria-pressed={decision === false}
          onClick={() => (onAnswer ?? approval.answer)(false)}
        >
          {decision === false ? "거부 선택됨" : "거부"}
        </Button>
      </CardFooter>
    </Card>
  );
}
