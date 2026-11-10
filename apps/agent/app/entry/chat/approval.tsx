import { isTruthy } from "../../truthy.ts";
import { Match, Option, Schema } from "effect";
import {
  CodeXmlIcon,
  FileWarningIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  DeleteOutsideFileInput,
  SaveCodeSkillInput,
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
import { chatCopy } from "./copy";
import { PendingApproval } from "./pending-approval";

const copy = chatCopy.approval;

/** A gated call's arguments, decoded once by tool name into a union the card can switch on. */
type GatedCall =
  | { readonly tool: "save_code_skill"; readonly input: typeof SaveCodeSkillInput.Type }
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

const decodeCodeSkill = Schema.decodeUnknownOption(Schema.fromJsonString(SaveCodeSkillInput));
const decodeWrite = Schema.decodeUnknownOption(Schema.fromJsonString(WriteOutsideFileInput));
const decodeDelete = Schema.decodeUnknownOption(Schema.fromJsonString(DeleteOutsideFileInput));
const decodeDelegation = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ agent: Schema.String, task: Schema.String })),
);

function decodeCall(toolName: string, argumentsJson: string): GatedCall {
  const unrecognized: GatedCall = { tool: "unrecognized", name: toolName, argumentsJson };
  const decoded = <A,>(input: Option.Option<A>, call: (input: A) => GatedCall) =>
    Option.match(input, { onNone: () => unrecognized, onSome: call });
  return Match.value(toolName).pipe(
    Match.withReturnType<GatedCall>(),
    Match.when("save_code_skill", () =>
      decoded(decodeCodeSkill(argumentsJson), (input) => ({ tool: "save_code_skill", input })),
    ),
    Match.when("write_outside_file", () =>
      decoded(decodeWrite(argumentsJson), (input) => ({ tool: "write_outside_file", input })),
    ),
    Match.when("delete_outside_file", () =>
      decoded(decodeDelete(argumentsJson), (input) => ({ tool: "delete_outside_file", input })),
    ),
    Match.when("delegate_to_agent", () =>
      decoded(decodeDelegation(argumentsJson), (input) => ({
        tool: "delegate_to_agent",
        ...input,
      })),
    ),
    Match.orElse(() => {
      // MCP tools are named mcp_<server>__<tool>.
      const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(toolName);
      return isTruthy(mcp)
        ? { tool: "mcp", server: mcp[1] ?? "", name: mcp[2] ?? toolName, argumentsJson }
        : unrecognized;
    }),
  );
}

/** Keeps a long file body readable in the card; the full text is what gets written. */
function preview(content: string) {
  const lines = content.split("\n");
  return lines.length > 20
    ? `${lines.slice(0, 20).join("\n")}\n${copy.moreLines(lines.length - 20)}`
    : content;
}

const codeBlock = "overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all";

/** The exact hosts a sh skill may reach, so approving it is a decision about named hosts. */
function ShellSkillNetwork({ hosts }: { readonly hosts: readonly string[] }) {
  if (hosts.length === 0) return <div>{copy.noNetwork}</div>;
  return (
    <div className="flex flex-col gap-1">
      <div>{copy.allowedHosts}</div>
      <ul className="flex flex-wrap gap-1">
        {hosts.map((host) => (
          <li key={host}>
            <code className="rounded bg-muted px-1">{host}</code>
          </li>
        ))}
      </ul>
      {hosts.some((host) => host.startsWith("*.")) && (
        <div className="text-muted-foreground">
          <code>*.</code>
          {copy.wildcardHostsAfterCode}
        </div>
      )}
      {hosts.includes("localhost") && (
        <div className="text-destructive">
          <code>localhost</code>
          {copy.localhostAfterCode}
        </div>
      )}
    </div>
  );
}

interface CallView {
  readonly title: string;
  readonly modelReason: string | undefined;
  readonly icon: LucideIcon;
  readonly body: React.ReactNode;
}

/** What saving a code skill approves: its program, and what that program may do on later runs. */
function codeSkillView(input: typeof SaveCodeSkillInput.Type): CallView {
  const program = Match.value(input.program).pipe(
    Match.discriminatorsExhaustive("runtime")({
      ts: ({ code, input: schema }) => ({
        kind: "TypeScript",
        icon: CodeXmlIcon,
        body: (
          <>
            <pre className={`max-h-60 ${codeBlock}`}>{code}</pre>
            {isTruthy(schema) ? (
              <div className="flex flex-col gap-1">
                <div>{copy.inputSchema}</div>
                <pre className={`max-h-40 ${codeBlock}`}>{JSON.stringify(schema, null, 2)}</pre>
              </div>
            ) : (
              <div>{copy.noInput}</div>
            )}
          </>
        ),
        note: copy.tsSkillNote,
      }),
      sh: ({ script, network = [] }) => ({
        kind: copy.shellKind,
        icon: TerminalIcon,
        body: (
          <>
            <pre className={`max-h-60 ${codeBlock}`}>{script}</pre>
            <ShellSkillNetwork hosts={network} />
          </>
        ),
        note: copy.shellSkillNote,
      }),
    }),
  );
  return {
    title: copy.saveSkillTitle(program.kind, input.name),
    modelReason: input.reason,
    icon: program.icon,
    body: (
      <div className="flex flex-col gap-2">
        <div>{input.description}</div>
        {program.body}
        <div className="text-muted-foreground">
          <code>.agents/skills/{input.name}/</code>
          {copy.savedAtAfterCode} {program.note}
        </div>
      </div>
    ),
  };
}

/** What the user is agreeing to. */
const describe = (call: GatedCall): CallView =>
  Match.value(call).pipe(
    Match.discriminatorsExhaustive("tool")({
      save_code_skill: ({ input }) => codeSkillView(input),
      write_outside_file: ({ input }) => ({
        title: copy.writeOutsideTitle,
        modelReason: input.reason,
        icon: FileWarningIcon,
        body: (
          <div className="flex flex-col gap-2">
            <div>
              <code className="break-all">{input.path}</code>{" "}
              <Badge variant="outline">
                {isTruthy(input.expectedSha256) ? copy.overwrite : copy.newFile}
              </Badge>
            </div>
            <pre className={`max-h-60 ${codeBlock}`}>{preview(input.content)}</pre>
          </div>
        ),
      }),
      delete_outside_file: ({ input }) => ({
        title: copy.deleteOutsideTitle,
        modelReason: input.reason,
        icon: FileWarningIcon,
        body: <code className="break-all">{input.path}</code>,
      }),
      delegate_to_agent: ({ agent, task }) => ({
        title: copy.delegateTitle(agent),
        modelReason: undefined,
        icon: FileWarningIcon,
        body: (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground">{copy.delegateNote}</div>
            <pre className={`max-h-60 ${codeBlock}`}>{preview(task)}</pre>
          </div>
        ),
      }),
      mcp: ({ name, server, argumentsJson }) => ({
        title: copy.mcpTitle(name),
        modelReason: undefined,
        icon: FileWarningIcon,
        body: (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground">
              {copy.mcpServer} <code>{server}</code>
            </div>
            <pre className={`max-h-60 ${codeBlock}`}>{preview(argumentsJson)}</pre>
          </div>
        ),
      }),
      unrecognized: ({ name, argumentsJson }) => ({
        title: copy.unrecognizedTitle(name),
        modelReason: undefined,
        icon: FileWarningIcon,
        body: <pre className={codeBlock}>{argumentsJson}</pre>,
      }),
    }),
  );

/** One pending approval for a code skill, an outside write or a delegated task. Approving runs exactly this call once. */
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
  /** A decision staged for the approvals the run waits for together. */
  decision?: boolean;
  onAnswer: (approved: boolean) => void;
}) {
  const view = describe(decodeCall(approval.toolName, approval.argumentsJson));
  const reviewReason = PendingApproval.$match(approval, {
    "tool-approval": () => null,
    "permission-review": (review) => (review.askedBy === "review" ? review.reviewReason : null),
  });
  const Icon = isTruthy(reviewReason) ? ShieldQuestionIcon : view.icon;
  return (
    <Card size="sm" variant="warning">
      <CardHeader>
        <CardTitle className="flex items-center">
          <Icon className="mr-2 size-4" />
          {isTruthy(requester) ? `${requester}: ${view.title}` : view.title}
        </CardTitle>
        <CardDescription className="flex flex-col">
          {reviewReason && (
            <span className="mb-0.5">
              {copy.autoReview} {reviewReason}
            </span>
          )}
          <span>
            {isTruthy(view.modelReason) ? copy.modelReason(view.modelReason) : copy.noModelReason}{" "}
            {copy.runsOnce}
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
          onClick={() => onAnswer(true)}
        >
          {decision === true ? copy.approveSelected : copy.approve}
        </Button>
        <Button
          size="sm"
          variant={decision === false ? "destructive" : "outline"}
          disabled={disabled}
          aria-pressed={decision === false}
          onClick={() => onAnswer(false)}
        >
          {decision === false ? copy.rejectSelected : copy.reject}
        </Button>
      </CardFooter>
    </Card>
  );
}
