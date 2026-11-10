import { type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRightIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { FieldDescription } from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  McpToolHint,
  mcpHint,
  mcpHintDefaults,
  mcpHintSource,
  type McpToolView,
} from "memory-agent/app-api";
import { McpCommand, type McpServerView } from "../../api";

/** The four MCP annotation hints, in the words the page shows them with. */
const hintLabels = {
  readOnly: msg({
    message: "읽기만 함",
    comment: "MCP tool hint: the tool does not change anything",
  }),
  destructive: msg({
    message: "지우거나 덮어씀",
    comment: "MCP tool hint: when the tool changes something, it may delete or overwrite",
  }),
  idempotent: msg({
    message: "다시 불러도 같음",
    comment: "MCP tool hint: calling the tool again with the same input changes nothing more",
  }),
  openWorld: msg({
    message: "바깥에 닿음",
    comment: "MCP tool hint: the tool reaches the web, other services or people",
  }),
} satisfies Record<McpToolHint, MessageDescriptor>;

const hintDescriptions = {
  readOnly: msg`아무것도 바꾸지 않습니다. 읽기만 하는 도구만 Plan 작성, 카드 실행, 검증 에이전트가 받습니다.`,
  destructive: msg`무언가를 바꿀 때 지우거나 덮어쓸 수 있습니다. 더하기만 하는 도구는 해당하지 않습니다.`,
  idempotent: msg`같은 입력으로 다시 불러도 더 바뀌는 것이 없습니다.`,
  openWorld: msg`웹, 다른 서비스, 다른 사람처럼 이 서버 밖에 닿습니다.`,
} satisfies Record<McpToolHint, MessageDescriptor>;

/** `destructive` and `idempotent` say what a change does, so the spec ignores them for read-only tools. */
const changeOnly: ReadonlySet<McpToolHint> = new Set(["destructive", "idempotent"]);

type Choice = "follow" | "yes" | "no";
const choiceOf = (value: boolean | null): Choice =>
  value === null ? "follow" : value ? "yes" : "no";
const valueOf = { follow: null, yes: true, no: false } as const satisfies Record<
  Choice,
  boolean | null
>;
const isChoice = (value: unknown): value is Choice =>
  value === "follow" || value === "yes" || value === "no";

/** One hint of one tool: what the server or the spec says, or the user's own value. */
function HintSelect({
  tool,
  hint,
  disabled,
  onChange,
}: {
  tool: McpToolView;
  hint: McpToolHint;
  disabled: boolean;
  onChange: (value: boolean | null) => void;
}) {
  const { t } = useLingui();
  const yes = t({ message: "예", comment: "Value of an MCP tool hint" });
  const no = t({ message: "아니오", comment: "Value of an MCP tool hint" });
  const shown = (tool.server[hint] ?? mcpHintDefaults[hint]) ? yes : no;
  const follow =
    tool.server[hint] === null
      ? t({
          message: `표시 없음, 기본값: ${shown}`,
          comment: "MCP tool hint the server does not give; {shown} is the spec's default (yes/no)",
        })
      : t({
          message: `서버 표시: ${shown}`,
          comment: "MCP tool hint as the server gives it; {shown} is yes or no",
        });
  const items = [
    { value: "follow", label: follow },
    { value: "yes", label: yes },
    { value: "no", label: no },
  ];
  const id = `${tool.name}-${hint}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium" title={t(hintDescriptions[hint])}>
        {t(hintLabels[hint])}
      </label>
      <Select
        value={choiceOf(tool.user[hint])}
        items={items}
        disabled={disabled}
        onValueChange={(value) => {
          if (isChoice(value)) onChange(valueOf[value]);
        }}
      >
        <SelectTrigger id={id} size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** What calling the tool does, as its hints say. */
function ToolSummary({ tool }: { tool: McpToolView }) {
  const readOnly = mcpHint(tool, "readOnly");
  const custom = McpToolHint.literals.some((hint) => mcpHintSource(tool, hint) === "user");
  return (
    <span className="flex flex-wrap items-center gap-1">
      {readOnly ? (
        <Badge variant="secondary">
          <Trans comment="Badge on an MCP tool that only reads">읽기 전용</Trans>
        </Badge>
      ) : mcpHint(tool, "destructive") ? (
        <Badge variant="destructive">
          <Trans comment="Badge on an MCP tool that may delete or overwrite">지우거나 덮어씀</Trans>
        </Badge>
      ) : (
        <Badge variant="outline">
          <Trans comment="Badge on an MCP tool that changes things without deleting">바꿈</Trans>
        </Badge>
      )}
      {mcpHint(tool, "openWorld") && (
        <Badge variant="outline">
          <Trans comment="Badge on an MCP tool that reaches outside the server">바깥에 닿음</Trans>
        </Badge>
      )}
      {custom && (
        <Badge variant="outline">
          <Trans comment="Badge on an MCP tool whose hints the user changed">직접 지정</Trans>
        </Badge>
      )}
    </span>
  );
}

/**
 * A connected server's tools with the MCP spec's annotation hints. The server's hints, or the
 * spec's cautious defaults where it gives none, apply until the user sets a value.
 */
export function McpToolHints({
  server,
  tools,
  busy,
  run,
}: {
  server: McpServerView;
  tools: readonly McpToolView[];
  busy: boolean;
  run: (command: McpCommand) => Promise<void>;
}) {
  const count = tools.length;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        <Trans comment="Toggle that shows how each of an MCP server's tools is classified; {count} is how many">
          도구 {count}개 분류
        </Trans>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">
        <FieldDescription>
          <Trans>
            MCP 표준의 도구 표시를 따릅니다. 서버가 표시하지 않은 값은 표준의 조심스러운 기본값을
            씁니다. 직접 고른 값이 서버 표시보다 우선합니다. 분류와 상관없이 도구를 부를 때마다 권한
            모드대로 묻습니다.
          </Trans>
        </FieldDescription>
        <ul className="flex flex-col gap-3">
          {tools.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-2 rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{tool.name}</code>
                <ToolSummary tool={tool} />
              </div>
              <div className="flex flex-wrap gap-3">
                {McpToolHint.literals
                  .filter((hint) => !(changeOnly.has(hint) && mcpHint(tool, "readOnly")))
                  .map((hint) => (
                    <HintSelect
                      key={hint}
                      tool={tool}
                      hint={hint}
                      disabled={busy}
                      onChange={(value) =>
                        void run(
                          McpCommand.toolHint({
                            scope: server.scope,
                            name: server.name,
                            tool: tool.name,
                            hint,
                            value,
                          }),
                        )
                      }
                    />
                  ))}
              </div>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
