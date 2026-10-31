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
  const [open, setOpen] = useState(false);
  const items = useDecisionInboxQuery(projectId).data ?? [];
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 flex-1 justify-start"
        onClick={() => setOpen(true)}
      >
        <InboxIcon />
        판단 대기
        {/* Only a waiting decision asks for attention; none is the usual state. */}
        {items.length > 0 && <Badge className="ml-auto">{items.length}</Badge>}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>판단 대기</SheetTitle>
            <SheetDescription>
              이 프로젝트의 모든 대화와 Goal에서 사람의 판단을 기다리는 카드예요. 여기서 답하거나
              카드가 있는 보드로 이동해요.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-xs text-muted-foreground">
            {items.length === 0 && <p>판단을 기다리는 카드가 없어요.</p>}
            {items.map((item) => (
              <section
                key={item.requestId}
                aria-label={`${item.cardTitle} 판단`}
                className="space-y-1.5 rounded-md border p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{item.cardTitle}</p>
                    <p className="truncate">
                      {item.sessionTitle ?? "제목 없는 대화"} · {koreanLocalTime(item.createdAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      onOpenCard(item.sessionId, item.cardId);
                    }}
                  >
                    카드 보기
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
    </>
  );
}
