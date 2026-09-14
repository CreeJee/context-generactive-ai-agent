import { ImageIcon, PencilIcon, SendIcon, XIcon } from "lucide-react";
import type { DeliveryVia, QueuedMessage } from "memory-agent/definitions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const deliveryLabel = (via: DeliveryVia) => {
  switch (via) {
    case "tool_boundary":
      return "전달됨 · 도구 호출 뒤";
    case "steer":
      return "전달됨 · 바로";
    case "next_turn":
      return "전달됨 · 다음 턴";
  }
};

function StateBadge({ message, editingHere }: { message: QueuedMessage; editingHere: boolean }) {
  const { state } = message;
  switch (state.kind) {
    case "waiting":
      return <Badge variant="outline">대기 중</Badge>;
    case "editing":
      return <Badge variant="secondary">{editingHere ? "편집 중" : "편집 중 · 저장 안 됨"}</Badge>;
    case "held":
      return (
        <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
          확인 필요{state.draft !== null ? " · 저장 안 된 편집" : ""}
        </Badge>
      );
    case "delivered":
      // Delivery is not a promise that the agent followed it, so the label says only "delivered".
      return <Badge variant="secondary">{deliveryLabel(state.via)}</Badge>;
    case "failed":
      return <Badge variant="destructive">전달 실패</Badge>;
  }
}

/**
 * Messages written while a run answered, in the order they will reach the agent. A message being
 * edited, or one held for confirmation, stops everything after it.
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
  // A message sent as the next turn is already in the conversation itself.
  const shown = items.filter(
    (message) => !(message.state.kind === "delivered" && message.state.via === "next_turn"),
  );
  if (shown.length === 0) return null;
  const busy = editingId !== null || readOnly;
  return (
    <div className="mx-auto mb-3 flex max-w-3xl flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>보낸 뒤 기다리는 메시지</span>
        <span>Alt+↑ 편집 · 편집 중 Enter 저장 · Esc 제거</span>
      </div>
      {shown.map((message) => {
        const editingHere = message.id === editingId;
        const kind = message.state.kind;
        return (
          <div
            key={message.id}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
              editingHere && "border-primary ring-1 ring-primary/40",
              kind === "delivered" && "opacity-60",
            )}
          >
            <StateBadge message={message} editingHere={editingHere} />
            <span className="min-w-0 flex-1 truncate">
              {message.text || "(이미지만)"}
              {message.attachmentIds.length > 0 && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                  <ImageIcon className="size-3" />
                  {message.attachmentIds.length}
                </span>
              )}
            </span>
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
            {(kind === "waiting" || kind === "held" || kind === "editing") && !editingHere && (
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy}
                aria-label="편집"
                onClick={() => onEdit(message)}
              >
                <PencilIcon />
              </Button>
            )}
            {kind !== "delivered" && (
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={readOnly}
                aria-label="제거"
                onClick={() => onRemove(message)}
              >
                <XIcon />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
