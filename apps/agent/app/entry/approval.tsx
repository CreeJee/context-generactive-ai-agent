import type { useChat } from "@tanstack/ai-react";
import { Option, Schema } from "effect";
import { FileWarningIcon, ShieldQuestionIcon, TerminalIcon } from "lucide-react";
import {
  DeleteOutsideFileInput,
  PermissionReviewPayload,
  RunShellInput,
  WriteOutsideFileInput,
  permissionReviewInterrupt,
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
export type ApprovalInterrupts = readonly [typeof permissionReviewInterrupt];
type ChatInterrupt = ReturnType<
  typeof useChat<ApprovalTools, undefined, unknown, ApprovalInterrupts>
>["interrupts"][number];

/** A call waiting for the user, whichever permission mode asked. */
export type PendingApproval =
  | {
      /** `ask` mode: TanStack paused before a needsApproval tool. */
      readonly kind: "tool-approval";
      readonly id: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
      readonly answer: (approved: boolean) => void;
    }
  | {
      /** `auto` mode: the review could not allow the call alone. */
      readonly kind: "permission-review";
      readonly id: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
      readonly reviewReason: string;
      /** Whether a review was unsure, or the tool asks on every call. */
      readonly askedBy: "review" | "every_call";
      readonly answer: (approved: boolean) => void;
    };

const decodeReview = Schema.decodeUnknownOption(
  Schema.Struct({ payload: PermissionReviewPayload }),
);

/**
 * Converts TanStack's interrupt union once, at the edge. Its two generic variants share
 * `kind: "generic"`, so the review is identified by the binding's definition id and its payload
 * is decoded rather than trusted.
 */
export function toPendingApproval(interrupt: ChatInterrupt): PendingApproval | null {
  switch (interrupt.kind) {
    case "tool-approval":
      return {
        kind: "tool-approval",
        id: interrupt.id,
        toolCallId: interrupt.toolCallId,
        toolName: interrupt.toolName,
        argumentsJson: JSON.stringify(interrupt.originalArgs),
        answer: (approved) => interrupt.resolveInterrupt(approved),
      };
    case "generic": {
      if (interrupt.binding.definitionId !== permissionReviewInterrupt.id) return null;
      const review = Option.getOrUndefined(decodeReview(interrupt));
      if (!review) return null;
      return {
        kind: "permission-review",
        id: interrupt.id,
        toolCallId: review.payload.toolCallId,
        toolName: review.payload.toolName,
        argumentsJson: review.payload.arguments,
        reviewReason: review.payload.reason,
        askedBy: review.payload.askedBy ?? "review",
        answer: (approved) => interrupt.resolveInterrupt({ approved }),
      };
    }
    case "unbound":
      return null;
  }
}

/** A gated call's arguments, decoded once by tool name into a union the card can switch on. */
type GatedCall =
  | { readonly tool: "run_shell"; readonly input: typeof RunShellInput.Type }
  | { readonly tool: "write_outside_file"; readonly input: typeof WriteOutsideFileInput.Type }
  | { readonly tool: "delete_outside_file"; readonly input: typeof DeleteOutsideFileInput.Type }
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
              실행 위치: <code>{call.input.workdir ?? "."}</code> (프로젝트 기준)
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
    case "mcp":
      return {
        title: `MCP 도구 ${call.name}을(를) 실행할까요?`,
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
}: {
  approval: PendingApproval;
  /** A read-only page shows the request but cannot answer it. */
  disabled: boolean;
}) {
  const view = describe(decodeCall(approval.toolName, approval.argumentsJson));
  const reviewReason =
    approval.kind === "permission-review" && approval.askedBy === "review"
      ? approval.reviewReason
      : null;
  const Icon = reviewReason ? ShieldQuestionIcon : view.shell ? TerminalIcon : FileWarningIcon;
  return (
    <Card size="sm" className="ring-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" />
          {view.title}
        </CardTitle>
        <CardDescription className="flex flex-col gap-0.5">
          {reviewReason && <span>자동 검토: {reviewReason}</span>}
          <span>
            {view.modelReason
              ? `모델이 밝힌 이유: ${view.modelReason}`
              : "모델이 이유를 적지 않았어요."}{" "}
            승인하면 이번 한 번만 실행돼요.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>{view.body}</CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" disabled={disabled} onClick={() => approval.answer(true)}>
          승인
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => approval.answer(false)}
        >
          거부
        </Button>
      </CardFooter>
    </Card>
  );
}
