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
import { type QueuedMessage, QueueItemState } from "memory-agent/definitions";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { isPending } from "../session/message-queue";
import { chatCopy } from "./copy";

const copy = chatCopy.queuePanel;

/** Icon, colour and short label for each state; delivery says only "delivered", never "done". */
function stateView(message: QueuedMessage, editingHere: boolean) {
  return QueueItemState.$match(message.state, {
    waiting: ({ steered }) => ({
      icon: Clock3Icon,
      tone: "text-muted-foreground",
      label: steered ? copy.steered : null,
    }),
    editing: () => ({
      icon: PencilLineIcon,
      tone: "text-primary",
      label: editingHere ? copy.editingHere : copy.editingElsewhere,
    }),
    held: ({ draft }) => ({
      icon: CircleAlertIcon,
      tone: "text-amber-600 dark:text-amber-400",
      label: draft === null ? copy.held : copy.heldWithDraft,
    }),
    delivered: ({ via }) => ({
      icon: CheckIcon,
      tone: "text-muted-foreground",
      label: copy.delivery[via],
    }),
    failed: () => ({ icon: CircleXIcon, tone: "text-destructive", label: copy.failed }),
  });
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
            variant="ghost-muted"
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
        <span className="font-medium">{copy.heading(shown.length)}</span>
        {!busy && (
          <span className="flex items-center gap-1">
            <KbdGroup>
              <Kbd>⌥</Kbd>
              <Kbd>↑</Kbd>
            </KbdGroup>
            {copy.editShortcut}
          </span>
        )}
      </div>
      <ul className="flex max-h-40 flex-col overflow-y-auto px-1.5 pb-1.5">
        {shown.map((message) => {
          const editingHere = message.id === editingId;
          const failed = QueueItemState.$is("failed")(message.state);
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
                {message.text || copy.imageOnly}
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
              {(failed || QueueItemState.$is("held")(message.state)) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onConfirm(message)}
                >
                  <SendIcon />
                  {copy.send}
                </Button>
              )}
              {!editingHere && (
                // Row actions stay out of the way until the row is hovered or focused.
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                  {!failed && (
                    <RowAction label={copy.edit} disabled={busy} onClick={() => onEdit(message)}>
                      <PencilIcon />
                    </RowAction>
                  )}
                  <RowAction
                    label={copy.remove}
                    disabled={readOnly}
                    onClick={() => onRemove(message)}
                  >
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
