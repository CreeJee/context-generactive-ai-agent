import { isTruthy } from "../../truthy.ts";
import { Option, Schema } from "effect";
import { FileWarningIcon, ShieldQuestionIcon, TerminalIcon } from "lucide-react";
import {
  DeleteOutsideFileInput,
  SaveShellSkillInput,
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
  | { readonly tool: "save_shell_skill"; readonly input: typeof SaveShellSkillInput.Type }
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

const decodeShellSkill = Schema.decodeUnknownOption(Schema.fromJsonString(SaveShellSkillInput));
const decodeWrite = Schema.decodeUnknownOption(Schema.fromJsonString(WriteOutsideFileInput));
const decodeDelete = Schema.decodeUnknownOption(Schema.fromJsonString(DeleteOutsideFileInput));
const decodeDelegation = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ agent: Schema.String, task: Schema.String })),
);

function decodeCall(toolName: string, argumentsJson: string): GatedCall {
  const unrecognized: GatedCall = { tool: "unrecognized", name: toolName, argumentsJson };
  switch (toolName) {
    case "save_shell_skill":
      return Option.match(decodeShellSkill(argumentsJson), {
        onNone: () => unrecognized,
        onSome: (input) => ({ tool: "save_shell_skill", input }),
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
      return isTruthy(mcp)
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

/** The exact hosts a shell skill may reach, so approving it is a decision about named hosts. */
function ShellSkillNetwork({ hosts }: { readonly hosts: readonly string[] }) {
  if (hosts.length === 0) return <div>네트워크: 접속하지 않아요.</div>;
  return (
    <div className="flex flex-col gap-1">
      <div>이 스크립트가 접속할 수 있는 호스트 (이 목록 밖으로는 막혀요):</div>
      <ul className="flex flex-wrap gap-1">
        {hosts.map((host) => (
          <li key={host}>
            <code className="rounded bg-muted px-1">{host}</code>
          </li>
        ))}
      </ul>
      {hosts.some((host) => host.startsWith("*.")) && (
        <div className="text-muted-foreground">
          <code>*.</code>으로 시작하는 항목은 그 도메인의 모든 하위 도메인을 포함해요.
        </div>
      )}
      {hosts.includes("localhost") && (
        <div className="text-destructive">
          <code>localhost</code>를 허용하면 이 앱 서버를 포함해 이 컴퓨터의 모든 로컬 서비스에
          접속할 수 있어요.
        </div>
      )}
    </div>
  );
}

interface CallView {
  readonly title: string;
  readonly modelReason: string | undefined;
  readonly shell: boolean;
  readonly body: React.ReactNode;
}

/** What the user is agreeing to. */
function describe(call: GatedCall): CallView {
  switch (call.tool) {
    case "save_shell_skill":
      return {
        title: `셸 스킬 ${call.input.name}을(를) 저장할까요?`,
        modelReason: call.input.reason,
        shell: true,
        body: (
          <div className="flex flex-col gap-2">
            <div>{call.input.description}</div>
            <pre className={`max-h-60 ${codeBlock}`}>{call.input.script}</pre>
            <ShellSkillNetwork hosts={call.input.network ?? []} />
            <div className="text-muted-foreground">
              <code>.agents/skills/{call.input.name}/</code>에 저장돼요. 승인하면 이 스크립트는
              내용이 바뀌기 전까지 인자만 바꿔 다시 묻지 않고 실행돼요. 실행은 샌드박스 안에서 하며,
              프로젝트·임시 폴더·패키지 캐시 밖에는 쓰지 못하고 자격증명 폴더는 읽지 못해요.
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
              <Badge variant="outline">
                {isTruthy(call.input.expectedSha256) ? "덮어쓰기" : "새 파일"}
              </Badge>
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
  const Icon = isTruthy(reviewReason)
    ? ShieldQuestionIcon
    : view.shell
      ? TerminalIcon
      : FileWarningIcon;
  return (
    <Card size="sm" variant="warning">
      <CardHeader>
        <CardTitle className="flex items-center">
          <Icon className="mr-2 size-4" />
          {isTruthy(requester) ? `${requester}: ${view.title}` : view.title}
        </CardTitle>
        <CardDescription className="flex flex-col">
          {reviewReason && <span className="mb-0.5">자동 검토: {reviewReason}</span>}
          <span>
            {isTruthy(view.modelReason)
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
