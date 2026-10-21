import { useState } from "react";
import { KanbanSquareIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { boardColumns, cardStatusLabels } from "../chat/board/board-moves";
import { StatusIcon } from "../chat/board/card-face";
import { planStatusLabels } from "../chat/workflow-panel";
import { useProjectBoardsQuery } from "../queries/project";
import { koreanLocalTime } from "../shared/local-time";

/**
 * The project's boards: every conversation whose Plan is a board, running ones first. Choosing one
 * goes to that conversation with its board open.
 */
export function BoardList({
  projectId,
  onOpenBoard,
}: {
  readonly projectId: string;
  readonly onOpenBoard: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boards = useProjectBoardsQuery(projectId).data ?? [];
  const running = boards.filter((board) => board.kanbanActive).length;
  return (
    <div className="px-2 py-1">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => setOpen(true)}
      >
        <KanbanSquareIcon />
        칸반 보드
        <Badge variant={running > 0 ? "default" : "secondary"} className="ml-auto">
          {boards.length}
        </Badge>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>칸반 보드</SheetTitle>
            <SheetDescription>
              이 프로젝트의 모든 대화에 있는 보드예요. 실행 중인 보드가 먼저 와요. 고르면 그 대화로
              가서 보드를 열어요.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 text-xs text-muted-foreground">
            {boards.length === 0 && (
              <p>아직 보드가 없어요. 대화에서 계획을 세우면 보드가 생겨요.</p>
            )}
            {boards.map((board) => {
              const total = boardColumns.reduce((sum, status) => sum + board.counts[status], 0);
              const done = board.counts.done;
              return (
                <button
                  type="button"
                  key={board.sessionId}
                  className="w-full cursor-pointer space-y-1.5 rounded-md border p-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setOpen(false);
                    onOpenBoard(board.sessionId);
                  }}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">
                        {board.sessionTitle ?? "제목 없는 대화"}
                      </p>
                      <p className="truncate">{board.plan.summary}</p>
                    </div>
                    {board.kanbanActive ? (
                      <Badge variant="secondary" className="shrink-0">
                        칸반 실행 중
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0">
                        {planStatusLabels[board.plan.status]}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium text-foreground">
                      완료 {done}/{total}
                    </span>
                    <span>Plan v{board.plan.version}</span>
                    <span>{koreanLocalTime(board.updatedAt)}</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="완료한 카드"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                    className="h-1 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full w-(--board-progress) rounded-full bg-primary"
                      style={{ "--board-progress": `${total === 0 ? 0 : (done / total) * 100}%` }}
                    />
                  </div>
                  <ul className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {boardColumns
                      .filter((status) => board.counts[status] > 0)
                      .map((status) => (
                        <li key={status} className="flex items-center gap-1">
                          <StatusIcon status={status} />
                          {cardStatusLabels[status]}
                          <span className="font-medium text-foreground">
                            {board.counts[status]}
                          </span>
                        </li>
                      ))}
                  </ul>
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
