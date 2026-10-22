import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronRightIcon, MessageSquareTextIcon, PlusIcon } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Field, FieldLabel } from "../../../components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet";
import type { ProjectBoard as ProjectBoardRow } from "memory-agent";
import { KanbanAction, useKanbanMutation } from "../../queries/mutations/session";
import { useDecisionInboxQuery, useProjectBoardsQuery } from "../../queries/project";
import { sessionQueries } from "../../queries/session";
import { LoopHealthStatus } from "../../shared/loop-health";
import { GoalPrioritySelect } from "../board-panel";
import { planStatusLabels } from "../workflow-panel";
import { boardColumns, type BoardCardRef } from "./board-moves";
import { BoardSurface, editErrorText, type SurfaceBoard } from "./board-surface";

const cardsOf = (row: ProjectBoardRow) =>
  boardColumns.reduce((sum, status) => sum + row.counts[status], 0);
const titleOf = (row: ProjectBoardRow) => row.sessionTitle ?? "제목 없는 대화";

/**
 * The project's kanban board: every conversation's Plan on one board of the same seven columns,
 * running Plans first. Each card names its conversation; a filter shows one conversation's cards
 * at a time. Cards are dragged, opened and decided here as on their own board, keep their order
 * inside their own Plan, and move to another conversation's Plan from the card peek. The server
 * checks the conversation's lease for each change.
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
  const rows = boards.data ?? [];
  const inbox = useDecisionInboxQuery(projectId).data ?? [];
  const views = useQueries({
    queries: rows.map((row) => sessionQueries.board(projectId, row.sessionId)),
  });
  const loops = useQueries({
    queries: rows.map((row) => sessionQueries.kanban(projectId, row.sessionId)),
  });
  const [shown, setShown] = useState<readonly string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const surfaces = rows.flatMap((row, index): SurfaceBoard[] => {
    const view = views[index]?.data;
    const plan = view?.plan ?? null;
    if (view === undefined || plan === null) return [];
    const loop = loops[index]?.data;
    return [
      {
        sessionId: row.sessionId,
        label: titleOf(row),
        view,
        plan,
        decisions: inbox.filter((item) => item.sessionId === row.sessionId),
        loop: loop?.active === true ? loop : null,
        ranks: row.ranks,
      },
    ];
  });
  const surfaceOf = (sessionId: string) =>
    surfaces.find((surface) => surface.sessionId === sessionId) ?? null;
  const running = rows.filter((row) => row.kanbanActive).length;
  const total = rows.reduce((sum, row) => sum + cardsOf(row), 0);
  const done = rows.reduce((sum, row) => sum + row.counts.done, 0);
  const toggleShown = (sessionId: string) =>
    setShown(
      shown.includes(sessionId) ? shown.filter((id) => id !== sessionId) : [...shown, sessionId],
    );

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
                대화 {rows.length}개{running > 0 && ` · 실행 중 ${running}`}
              </span>
              <span>
                완료 {done}/{total}
              </span>
              {inbox.length > 0 && <Badge variant="outline">판단 대기 {inbox.length}</Badge>}
              <span className="hidden sm:inline">
                이 프로젝트 모든 대화의 카드를 한 보드에서 봐요. 순서는 같은 대화의 카드끼리 바꾸고,
                카드를 열면 다른 대화로 옮길 수 있어요.
              </span>
            </span>
          </SheetDescription>
          {rows.length > 1 && (
            <div role="group" aria-label="보이는 대화" className="mt-1 flex flex-wrap gap-1">
              <Button
                type="button"
                size="xs"
                variant={shown.length === 0 ? "secondary" : "ghost"}
                aria-pressed={shown.length === 0}
                onClick={() => setShown([])}
              >
                모든 대화
              </Button>
              {rows.map((row) => (
                <Button
                  key={row.sessionId}
                  type="button"
                  size="xs"
                  variant={shown.includes(row.sessionId) ? "secondary" : "ghost"}
                  aria-pressed={shown.includes(row.sessionId)}
                  onClick={() => toggleShown(row.sessionId)}
                >
                  {titleOf(row)}
                </Button>
              ))}
            </div>
          )}
          {rows.length > 0 && (
            <Collapsible className="rounded-md border">
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]:rotate-90" />
                <span className="font-medium">대화별 상태 · 동작</span>
                {inbox.length > 0 && <Badge variant="outline">판단 대기 {inbox.length}</Badge>}
              </CollapsibleTrigger>
              <CollapsibleContent className="max-h-60 divide-y overflow-y-auto border-t">
                {rows.map((row) => (
                  <ConversationRow
                    key={row.sessionId}
                    projectId={projectId}
                    holder={holder}
                    row={row}
                    surface={surfaceOf(row.sessionId)}
                    decisions={inbox.filter((item) => item.sessionId === row.sessionId).length}
                    onAdd={() => setAdding(row.sessionId)}
                    onOpenSession={() => onOpenSession(row.sessionId)}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </SheetHeader>
        {boards.data === undefined && (
          <p className="px-4 text-muted-foreground">보드를 불러오는 중이에요.</p>
        )}
        {boards.data !== undefined && rows.length === 0 && (
          <p className="px-4 text-muted-foreground">
            아직 보드가 없어요. 대화에서 계획을 세우면 보드가 생겨요.
          </p>
        )}
        {rows.length > 0 && (
          <BoardSurface
            projectId={projectId}
            holder={holder}
            disabled={false}
            boards={surfaces}
            shown={shown}
            peek={peek}
            onPeek={onPeek}
            adding={adding}
            onAddingChange={setAdding}
            onDraggingChange={setDragging}
            className="min-h-0 flex-1 pt-3"
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * One conversation's line in the board's status panel: its Plan, its loop and the actions that
 * belong to the whole Plan rather than to a card. The Goal's priority, set here, is where its
 * cards enter the project's order until a person drags them into place on the board.
 */
function ConversationRow({
  projectId,
  holder,
  row,
  surface,
  decisions,
  onAdd,
  onOpenSession,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly row: ProjectBoardRow;
  /** The conversation's board as the surface shows it; null until it has loaded. */
  readonly surface: SurfaceBoard | null;
  readonly decisions: number;
  readonly onAdd: () => void;
  readonly onOpenSession: () => void;
}) {
  const kanbanAction = useKanbanMutation(projectId, row.sessionId, holder);
  const [actionError, setActionError] = useState<string | null>(null);
  const title = titleOf(row);
  const loop = surface?.loop ?? null;
  const schedule = loop?.schedule ?? null;
  const pendingChanges = surface?.view.pendingChanges.length ?? 0;
  const act = (action: KanbanAction) => {
    setActionError(null);
    kanbanAction.mutate(action, { onError: (error) => setActionError(editErrorText(error)) });
  };

  return (
    <section
      aria-label={`${title} 대화`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs"
    >
      <h3 className="min-w-0 max-w-full truncate text-sm font-medium">{title}</h3>
      {row.kanbanActive ? (
        <Badge variant="secondary">칸반 실행 중</Badge>
      ) : (
        <Badge variant="outline">{planStatusLabels[row.plan.status]}</Badge>
      )}
      {loop !== null && (
        <LoopHealthStatus
          label="보드 루프"
          health={loop.loop}
          disabled={kanbanAction.isPending}
          onRestart={() => act(KanbanAction.RestartLoop())}
        />
      )}
      <span className="text-muted-foreground">
        Plan v{row.plan.version} · 완료 {row.counts.done}/{cardsOf(row)}
      </span>
      {decisions > 0 && <Badge variant="outline">판단 대기 {decisions}</Badge>}
      {pendingChanges > 0 && <Badge variant="outline">변경 요청 대기 {pendingChanges}</Badge>}
      {schedule !== null && (
        <Field orientation="horizontal" className="w-auto">
          <FieldLabel htmlFor={`goal-priority-${row.sessionId}`}>우선순위</FieldLabel>
          <GoalPrioritySelect
            id={`goal-priority-${row.sessionId}`}
            value={schedule.priority}
            disabled={kanbanAction.isPending}
            onChange={(priority) => act(KanbanAction.SetPriority({ priority }))}
          />
        </Field>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {loop === null && row.plan.status === "executing" && (
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
          disabled={surface === null || surface.plan.status === "completed"}
          onClick={onAdd}
        >
          <PlusIcon data-icon="inline-start" />
          카드 추가
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={onOpenSession}>
          <MessageSquareTextIcon data-icon="inline-start" />
          대화 열기
        </Button>
      </span>
      {actionError !== null && (
        <p className="basis-full text-destructive" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
