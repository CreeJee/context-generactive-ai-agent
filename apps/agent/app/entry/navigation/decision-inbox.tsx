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
import { BoardIntent } from "../api";
import { DecisionPrompt } from "../chat/decision-prompt";
import { intentErrorText } from "../chat/board/board-surface";
import { KanbanAction, useBoardsKanbanMutation } from "../queries/mutations/session";
import { useDecisionInboxQuery, useProjectBoardsQuery } from "../queries/project";
import { LoadFailure } from "../shared/load-failure";
import { koreanLocalTime } from "../shared/local-time";

/**
 * The project inbox: every card decision and every card awaiting approval, across conversations
 * and Goals. Each one can be answered or approved here, or opened on its board.
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
  const inbox = useDecisionInboxQuery(projectId);
  const boards = useProjectBoardsQuery(projectId);
  const items = inbox.data ?? [];
  // A list that did not load is not an empty one.
  const failed = inbox.isError || boards.isError;
  const approvals = (boards.data ?? []).flatMap((board) =>
    board.awaitingApproval.map((card) => ({ ...card, board })),
  );
  const approve = useBoardsKanbanMutation(holder)(projectId);
  const [approveError, setApproveError] = useState<string | null>(null);
  const count = items.length + approvals.length;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={() => setOpen(true)}>
        <InboxIcon />
        <span>
          <Trans comment="Sidebar menu item: card decisions waiting for a person">판단 대기</Trans>
        </span>
      </SidebarMenuButton>
      {/* Only a waiting decision asks for attention; none is the usual state. */}
      {count > 0 && (
        <SidebarMenuBadge>
          <Badge>{count}</Badge>
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
                이 프로젝트의 모든 대화와 Goal에서 사람의 판단이나 승인을 기다리는 카드입니다.
                여기서 답하거나 승인하고, 카드가 있는 보드로 이동합니다.
              </Trans>
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-xs text-muted-foreground">
            {failed && (
              <LoadFailure
                onRetry={() => {
                  void inbox.refetch();
                  void boards.refetch();
                }}
              >
                <Trans>판단을 기다리는 카드를 불러오지 못했습니다.</Trans>
              </LoadFailure>
            )}
            {count === 0 && !failed && (
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
            {approveError !== null && (
              <p role="alert" className="text-destructive">
                {approveError}
              </p>
            )}
            {approvals.map(({ cardId, title, board }) => (
              <section
                key={`${board.sessionId}:${cardId}`}
                aria-label={t({
                  message: `${ph({ cardTitle: title })} 승인`,
                  comment:
                    "Label of one card awaiting approval; cardTitle is its kanban card's title",
                })}
                className="space-y-1.5 rounded-md border p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{title}</p>
                    <p className="truncate">
                      {board.sessionTitle ?? t`제목 없는 대화`} ·{" "}
                      <Trans comment="A card waiting for the user's approval">승인 대기</Trans>
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      onOpenCard(board.sessionId, cardId);
                    }}
                  >
                    <Trans comment="Button that opens the decision's card on its board">
                      카드 보기
                    </Trans>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={approve.isPending}
                    onClick={() => {
                      setApproveError(null);
                      approve.mutate(
                        {
                          sessionId: board.sessionId,
                          action: KanbanAction.Intent({ intent: BoardIntent.Approve({ cardId }) }),
                        },
                        { onError: (error) => setApproveError(intentErrorText("Approve", error)) },
                      );
                    }}
                  >
                    <Trans comment="Button that approves a card the planner added">승인</Trans>
                  </Button>
                </div>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </SidebarMenuItem>
  );
}
