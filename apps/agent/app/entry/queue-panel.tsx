import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  Clock3Icon,
  ImageIcon,
  PencilIcon,
  PencilLineIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import type { DeliveryVia, QueuedMessage } from "memory-agent/definitions";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { isPending } from "./message-queue";

const deliveryLabel = (via: DeliveryVia) => {
  switch (via) {
    case "tool_boundary":
      return "도구 호출 뒤 전달됨";
    case "steer":
      return "바로 전달됨";
    case "next_turn":
      return "다음 턴으로 전달됨";
  }
};

/** Icon, colour and short label for each state; delivery says only "delivered", never "done". */
function stateView(message: QueuedMessage, editingHere: boolean) {
  const { state } = message;
  switch (state.kind) {
    case "waiting":
      return { icon: Clock3Icon, tone: "text-muted-foreground", label: null };
    case "editing":
      return {
        icon: PencilLineIcon,
        tone: "text-primary",
        label: editingHere ? "편집 중" : "편집 중, 저장 안 됨",
      };
    case "held":
      return {
        icon: CircleAlertIcon,
        tone: "text-amber-600 dark:text-amber-400",
        label: state.draft === null ? "확인 필요" : "확인 필요, 편집 저장 안 됨",
      };
    case "delivered":
      return { icon: CheckIcon, tone: "text-muted-foreground", label: deliveryLabel(state.via) };
    case "failed":
      return { icon: CircleXIcon, tone: "text-destructive", label: "전달 실패" };
  }
}

function RowAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The top of the composer: messages written while a run answered, in the order they reach the
 * agent. A message being edited, or one held for confirmation, stops everything after it.
 */
export function QueuePanel({
  items,
  editingId,
  readOnly,
  onEdit,
  onRemove,
  onConfirm,
}: {
  items: readonly QueuedMessage[];
  editingId: string | null;
  readOnly: boolean;
  onEdit: (message: QueuedMessage) => void;
  onRemove: (message: QueuedMessage) => void;
  onConfirm: (message: QueuedMessage) => void;
}) {
  // A delivered message leaves the queue: the conversation shows it from then on.
  const shown = items.filter(isPending);
  if (shown.length === 0) return null;
  const busy = editingId !== null || readOnly;

  return (
    <div className="flex w-full flex-col border-b">
      <div className="flex items-center justify-between px-3 pt-2 pb-1 text-2xs text-muted-foreground">
        <span className="font-medium">보낼 메시지 {shown.length}개</span>
        {!busy && (
          <span className="flex items-center gap-1">
            <KbdGroup>
              <Kbd>⌥</Kbd>
              <Kbd>↑</Kbd>
            </KbdGroup>
            편집
          </span>
        )}
      </div>
      <ul className="flex max-h-40 flex-col overflow-y-auto px-1.5 pb-1.5">
        {shown.map((message) => {
          const editingHere = message.id === editingId;
          const kind = message.state.kind;
          const view = stateView(message, editingHere);
          const Icon = view.icon;
          return (
            <li
              key={message.id}
              className={cn(
                "group/row flex h-8 items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-muted/60",
                editingHere && "bg-primary/5 hover:bg-primary/10",
              )}
            >
              <Icon className={cn("size-3.5 shrink-0", view.tone)} />
              <span className="min-w-0 flex-1 truncate">
                {message.text || "이미지"}
                {message.attachmentIds.length > 0 && (
                  <span className="ml-1.5 inline-flex translate-y-px items-center gap-0.5 text-xs text-muted-foreground">
                    <ImageIcon className="size-3" />
                    {message.attachmentIds.length}
                  </span>
                )}
              </span>
              {view.label && (
                <span className={cn("shrink-0 text-xs", view.tone)}>{view.label}</span>
              )}
              {(kind === "held" || kind === "failed") && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onConfirm(message)}
                >
                  <SendIcon />
                  보내기
                </Button>
              )}
              {!editingHere && (
                // Row actions stay out of the way until the row is hovered or focused.
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                  {kind !== "failed" && (
                    <RowAction label="편집" disabled={busy} onClick={() => onEdit(message)}>
                      <PencilIcon />
                    </RowAction>
                  )}
                  <RowAction label="지우기" disabled={readOnly} onClick={() => onRemove(message)}>
                    <XIcon />
                  </RowAction>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
