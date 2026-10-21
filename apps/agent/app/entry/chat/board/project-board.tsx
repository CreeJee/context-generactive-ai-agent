import { useState } from "react";
import { ChevronRightIcon, MessageSquareTextIcon, PlusIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet";
import type { ProjectBoard as ProjectBoardLane } from "memory-agent";
import type { HumanDecisionRequest } from "../../api";
import { KanbanAction, useKanbanMutation } from "../../queries/mutations/session";
import { useDecisionInboxQuery, useProjectBoardsQuery } from "../../queries/project";
import { useBoardQuery, useKanbanQuery } from "../../queries/session";
import { LoopHealthStatus } from "../../shared/loop-health";
import { planStatusLabels } from "../workflow-panel";
import { boardColumns } from "./board-moves";
import { BoardSurface, editErrorText } from "./board-surface";

/** A card of the project board, named by its conversation and card: the `boardCard` query. */
export interface BoardCardRef {
  readonly sessionId: string;
  readonly cardId: string;
}

/** Session ids are UUIDs, so the first colon splits the two. Card ids may hold any character. */
export const boardCardKey = ({ sessionId, cardId }: BoardCardRef) => `${sessionId}:${cardId}`;
export const parseBoardCardKey = (key: string): BoardCardRef | null => {
  const at = key.indexOf(":");
  return at < 0 ? null : { sessionId: key.slice(0, at), cardId: key.slice(at + 1) };
};

const cardsOf = (lane: ProjectBoardLane) =>
  boardColumns.reduce((sum, status) => sum + lane.counts[status], 0);

/**
 * The project's kanban board: every conversation's Plan as a lane of the same seven columns,
 * running boards first. Each lane is that conversation's board, so cards are dragged, opened and
 * decided here as they are there; the server checks the conversation's lease for each change.
 */
export function ProjectBoard({
  projectId,
  holder,
  peek,
  onPeek,
  onOpenSession,
  onClose,
}: {
  readonly projectId: string;
  readonly holder: string;
  /** The card open in the peek panel, from the `boardCard` query. */
  readonly peek: BoardCardRef | null;
  readonly onPeek: (card: BoardCardRef | null) => void;
  /** Goes to the conversation with its own board open. */
  readonly onOpenSession: (sessionId: string) => void;
  readonly onClose: () => void;
}) {
  const boards = useProjectBoardsQuery(projectId);
  const lanes = boards.data ?? [];
  const inbox = useDecisionInboxQuery(projectId).data ?? [];
  const [folded, setFolded] = useState<readonly string[]>([]);
  const [dragging, setDragging] = useState(false);
  const running = lanes.filter((lane) => lane.kanbanActive).length;
  const total = lanes.reduce((sum, lane) => sum + cardsOf(lane), 0);
  const done = lanes.reduce((sum, lane) => sum + lane.counts.done, 0);

  return (
    <Sheet
      open
      onOpenChange={(next, details) => {
        // Esc while a card is picked up puts the card back; the board stays open.
        if (!next && dragging && details.reason === "escape-key") return details.cancel();
        if (!next) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-none">
        <SheetHeader>
          <SheetTitle>프로젝트 칸반 보드</SheetTitle>
          <SheetDescription>
            <span className="flex flex-wrap items-center gap-2">
              <span>
                보드 {lanes.length}개{running > 0 && ` · 실행 중 ${running}`}
              </span>
              <span>
                완료 {done}/{total}
              </span>
              {inbox.length > 0 && <Badge variant="outline">판단 대기 {inbox.length}</Badge>}
              <span className="hidden sm:inline">
                이 프로젝트의 모든 대화 보드를 Goal별 줄로 보여줘요. 실행 중인 보드가 먼저 와요.
                카드는 그 대화의 보드에서처럼 끌어 옮기고 열어요.
              </span>
            </span>
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
          {boards.data === undefined && (
            <p className="text-muted-foreground">보드를 불러오는 중이에요.</p>
          )}
          {boards.data !== undefined && lanes.length === 0 && (
            <p className="text-muted-foreground">
              아직 보드가 없어요. 대화에서 계획을 세우면 보드가 생겨요.
            </p>
          )}
          {lanes.map((lane) => (
            <BoardLane
              key={lane.sessionId}
              projectId={projectId}
              holder={holder}
              lane={lane}
              decisions={inbox.filter((item) => item.sessionId === lane.sessionId)}
              folded={folded.includes(lane.sessionId)}
              peekCardId={peek?.sessionId === lane.sessionId ? peek.cardId : null}
              onToggle={() =>
                setFolded(
                  folded.includes(lane.sessionId)
                    ? folded.filter((id) => id !== lane.sessionId)
                    : [...folded, lane.sessionId],
                )
              }
              onPeek={(cardId) =>
                onPeek(cardId === null ? null : { sessionId: lane.sessionId, cardId })
              }
              onOpenSession={() => onOpenSession(lane.sessionId)}
              onDraggingChange={setDragging}
            />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One conversation's board as a lane: its header from the list, its cards from its own board. */
function BoardLane({
  projectId,
  holder,
  lane,
  decisions,
  folded,
  peekCardId,
  onToggle,
  onPeek,
  onOpenSession,
  onDraggingChange,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly lane: ProjectBoardLane;
  readonly decisions: readonly HumanDecisionRequest[];
  readonly folded: boolean;
  readonly peekCardId: string | null;
  readonly onToggle: () => void;
  readonly onPeek: (cardId: string | null) => void;
  readonly onOpenSession: () => void;
  readonly onDraggingChange: (dragging: boolean) => void;
}) {
  const board = useBoardQuery(projectId, lane.sessionId);
  const kanban = useKanbanQuery(projectId, lane.sessionId);
  const kanbanAction = useKanbanMutation(projectId, lane.sessionId, holder);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const title = lane.sessionTitle ?? "제목 없는 대화";
  const view = board.data;
  const plan = view?.plan ?? null;
  const loop = kanban.data?.active === true ? kanban.data : null;
  const total = cardsOf(lane);
  const closed = lane.plan.status === "completed";
  const act = (action: KanbanAction) => {
    setActionError(null);
    kanbanAction.mutate(action, { onError: (error) => setActionError(editErrorText(error)) });
  };

  return (
    <section aria-label={`${title} 보드`} className="rounded-lg border">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={folded ? `${title} 보드 펼치기` : `${title} 보드 접기`}
          aria-expanded={!folded}
          onClick={onToggle}
        >
          <ChevronRightIcon className={cn("transition-transform", !folded && "rotate-90")} />
        </Button>
        <h3 className="min-w-0 max-w-full truncate text-sm font-medium">{title}</h3>
        {lane.kanbanActive ? (
          <Badge variant="secondary">칸반 실행 중</Badge>
        ) : (
          <Badge variant="outline">{planStatusLabels[lane.plan.status]}</Badge>
        )}
        {loop !== null && (
          <LoopHealthStatus
            label="보드 루프"
            health={loop.loop}
            disabled={kanbanAction.isPending}
            onRestart={() => act(KanbanAction.RestartLoop())}
          />
        )}
        <span className="text-xs text-muted-foreground">
          Plan v{lane.plan.version} · 완료 {lane.counts.done}/{total}
        </span>
        {decisions.length > 0 && <Badge variant="outline">판단 대기 {decisions.length}</Badge>}
        {view !== undefined && view.pendingChanges.length > 0 && (
          <Badge variant="outline">변경 요청 대기 {view.pendingChanges.length}</Badge>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {loop === null && lane.plan.status === "executing" && (
            <Button
              type="button"
              size="xs"
              disabled={kanbanAction.isPending}
              onClick={() => act(KanbanAction.Start())}
            >
              칸반으로 실행
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={closed || plan === null}
            onClick={() => setAdding(true)}
          >
            <PlusIcon data-icon="inline-start" />
            카드 추가
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={onOpenSession}>
            <MessageSquareTextIcon data-icon="inline-start" />
            대화 열기
          </Button>
        </span>
      </header>
      {actionError !== null && (
        <p className="px-3 pb-2 text-destructive" role="alert">
          {actionError}
        </p>
      )}
      {!folded && (
        <>
          <p className="truncate px-3 pb-2 text-xs text-muted-foreground">{lane.plan.summary}</p>
          {view === undefined && (
            <p className="px-3 pb-3 text-muted-foreground">보드를 불러오는 중이에요.</p>
          )}
          {view !== undefined && plan === null && (
            <p className="px-3 pb-3 text-muted-foreground">아직 계획이 없어요.</p>
          )}
          {view !== undefined && plan !== null && (
            <BoardSurface
              projectId={projectId}
              sessionId={lane.sessionId}
              holder={holder}
              disabled={false}
              view={view}
              plan={plan}
              decisions={decisions}
              loop={loop}
              kanbanAction={kanbanAction}
              peekCardId={peekCardId}
              onPeek={onPeek}
              adding={adding}
              onAddingChange={setAdding}
              onDraggingChange={onDraggingChange}
              className="flex max-h-[32rem] flex-col"
            />
          )}
        </>
      )}
    </section>
  );
}
