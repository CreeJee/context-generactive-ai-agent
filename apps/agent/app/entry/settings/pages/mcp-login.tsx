import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { defaultMcpClientName } from "memory-agent/app-api";
import { useId, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { McpCommand, type McpServerView } from "../../api";

/**
 * Client names a login that registers its client can give. Some authorization servers register
 * only the client names they know, and refuse others with 403.
 */
const presetNames = { default: defaultMcpClientName, claudeCode: "Claude Code" } as const;
type Choice = keyof typeof presetNames | "custom";
const choices = ["default", "claudeCode", "custom"] as const satisfies readonly Choice[];

const defaultLabel = msg({
  message: `${defaultMcpClientName} (기본)`,
  comment: "Option for the OAuth client name this app gives by default; the name is a code value",
});
const customLabel = msg({
  message: "직접 입력",
  comment: "Option that lets the user type their own OAuth client name",
});

const choiceOf = (name: string): Choice =>
  choices.find((choice) => choice !== "custom" && presetNames[choice] === name) ?? "custom";

/**
 * A login to a server whose client registers itself: the person picks the client name first, the
 * one chosen last already selected.
 */
export function McpLoginDialog({
  server,
  clientName,
  busy,
  variant,
  run,
  children,
}: {
  server: McpServerView;
  /** The name the next login registers under. */
  clientName: string;
  busy: boolean;
  variant: "outline" | "ghost-muted";
  run: (command: McpCommand) => Promise<void>;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const selectId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>(() => choiceOf(clientName));
  const [custom, setCustom] = useState("");
  const chosen = choice === "custom" ? custom.trim() : presetNames[choice];
  const serverName = server.name;
  const items = choices.map((value) => ({
    value,
    label:
      value === "default"
        ? t(defaultLabel)
        : value === "custom"
          ? t(customLabel)
          : presetNames[value],
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Each opening starts from the name the next login would use.
        if (next) {
          setChoice(choiceOf(clientName));
          setCustom(choiceOf(clientName) === "custom" ? clientName : "");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button size="sm" variant={variant} disabled={busy} />}>
        {children}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen === "") return;
            setOpen(false);
            void run(
              McpCommand.login({ scope: server.scope, name: server.name, clientName: chosen }),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>{serverName} 서버에 로그인</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                로그인할 때 이 앱은 서버에 이 이름으로 자기를 등록합니다. 어떤 서버는 아는 앱 이름만
                받고 다른 이름은 거절합니다. 고른 이름은 이 서버의 다음 로그인에도 씁니다.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={selectId}>
              <Trans comment="Label of the select that picks the OAuth client name for an MCP login">
                클라이언트 이름
              </Trans>
            </FieldLabel>
            <Select
              value={choice}
              items={items}
              onValueChange={(value) => {
                const next = choices.find((option) => option === value);
                if (next !== undefined) setChoice(next);
              }}
            >
              <SelectTrigger id={selectId} className="w-full">
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
            {choice === "custom" && (
              <Input
                id={inputId}
                aria-label={t({
                  message: "직접 입력한 클라이언트 이름",
                  comment: "Field where the user types their own OAuth client name",
                })}
                value={custom}
                maxLength={100}
                onChange={(event) => setCustom(event.target.value)}
                autoFocus
              />
            )}
            {choice !== "default" && (
              <FieldDescription>
                <Trans>다른 앱의 이름으로 등록하면 그 서버의 이용 약관에 어긋날 수 있습니다.</Trans>
              </FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost-muted" />}>
              <Trans comment="Dialog button that cancels">취소</Trans>
            </DialogClose>
            <Button type="submit" disabled={chosen === ""}>
              <Trans comment="Dialog button that starts an MCP server's OAuth login">로그인</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
