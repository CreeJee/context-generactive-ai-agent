import { ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { InboxIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { DecisionPrompt } from "../chat/decision-prompt";
import { useDecisionInboxQuery } from "../queries/project";
import { koreanLocalTime } from "../shared/local-time";

/**
 * The project inbox: every card decision waiting for a person, across conversations and Goals.
 * Each one can be answered here or opened on its board.
 */
export function DecisionInbox({
  projectId,
  holder,
  onOpenCard,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly onOpenCard: (sessionId: string, cardId: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const items = useDecisionInboxQuery(projectId).data ?? [];
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={() => setOpen(true)}>
        <InboxIcon />
        <span>
          <Trans comment="Sidebar menu item: card decisions waiting for a person">판단 대기</Trans>
        </span>
      </SidebarMenuButton>
      {/* Only a waiting decision asks for attention; none is the usual state. */}
      {items.length > 0 && (
        <SidebarMenuBadge>
          <Badge>{items.length}</Badge>
        </SidebarMenuBadge>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>
              <Trans comment="Sheet title: card decisions waiting for a person">판단 대기</Trans>
            </SheetTitle>
            <SheetDescription>
              <Trans>
                이 프로젝트의 모든 대화와 Goal에서 사람의 판단을 기다리는 카드입니다. 여기서
                답하거나 카드가 있는 보드로 이동합니다.
              </Trans>
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-xs text-muted-foreground">
            {items.length === 0 && (
              <p>
                <Trans>판단을 기다리는 카드가 없습니다.</Trans>
              </p>
            )}
            {items.map((item) => (
              <section
                key={item.requestId}
                aria-label={t({
                  message: `${ph({ cardTitle: item.cardTitle })} 판단`,
                  comment: "Label of one waiting decision; cardTitle is its kanban card's title",
                })}
                className="space-y-1.5 rounded-md border p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{item.cardTitle}</p>
                    <p className="truncate">
                      {item.sessionTitle ?? t`제목 없는 대화`} · {koreanLocalTime(item.createdAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      onOpenCard(item.sessionId, item.cardId);
                    }}
                  >
                    <Trans comment="Button that opens the decision's card on its board">
                      카드 보기
                    </Trans>
                  </Button>
                </div>
                <DecisionPrompt
                  projectId={projectId}
                  holder={holder}
                  request={item}
                  disabled={false}
                />
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </SidebarMenuItem>
  );
}
