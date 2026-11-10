import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MessageSquareTextIcon,
  PlusIcon,
} from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet";
import { Toggle } from "../../../components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import type { ProjectBoard as ProjectBoardRow } from "memory-agent";
import { useGoalOrderMutation } from "../../queries/mutations/project";
import { KanbanAction, useKanbanMutation } from "../../queries/mutations/session";
import { useDecisionInboxQuery, useProjectBoardsQuery } from "../../queries/project";
import { sessionQueries } from "../../queries/session";
import { LoopHealthStatus } from "../../shared/loop-health";
import { planStatusLabels } from "../workflow-panel";
import { boardColumns, type BoardCardRef } from "./board-moves";
import { BoardSurface, editErrorText, type SurfaceBoard } from "./board-surface";
import { BoardShortcuts } from "./kanban-board";
import { Array as Arr } from "effect";

const cardsOf = (row: ProjectBoardRow) =>
  boardColumns.reduce((sum, status) => sum + row.counts[status], 0);
const untitled = msg`제목 없는 대화`;
const titleOf = (row: ProjectBoardRow) => row.sessionTitle ?? i18n._(untitled);
/** Only an executing Plan's cards are the scheduler's business, so only those are on the board. */
const onBoard = (row: ProjectBoardRow) => row.plan.status === "executing";

/**
 * The project's kanban board: every executing Plan on one board of the same seven columns, in the
 * priority tree's order (the status panel moves a conversation's Goal up and down). Each card
 * names its conversation; a filter shows one conversation's cards at a time. Cards are dragged,
 * opened and decided here as on their own board, keep their order inside their own Plan, and move
 * to another conversation's Plan from the card peek. Plans not executing are only named, with a
 * way to their conversation. The server checks the conversation's lease for each change.
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
  const { t } = useLingui();
  const boards = useProjectBoardsQuery(projectId);
  const everyRow = [...(boards.data ?? [])].sort((a, b) => a.rank - b.rank);
  const rows = everyRow.filter(onBoard);
  const waiting = everyRow.filter((row) => !onBoard(row));
  const inbox = useDecisionInboxQuery(projectId).data ?? [];
  // Cards awaiting approval wait for the user too, as the inbox counts them.
  const awaiting = everyRow.reduce((sum, row) => sum + row.awaitingApproval.length, 0);
  const order = useGoalOrderMutation(projectId);
  const views = useQueries({
    queries: rows.map((row) => sessionQueries.board(projectId, row.sessionId)),
  });
  const loops = useQueries({
    queries: rows.map((row) => sessionQueries.kanban(projectId, row.sessionId)),
  });
  const [shown, setShown] = useState<readonly string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
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
        rank: row.rank,
      },
    ];
  });
  const surfaceOf = (sessionId: string) =>
    surfaces.find((surface) => surface.sessionId === sessionId) ?? null;
  const running = Arr.countBy(rows, (row) => row.kanbanActive);
  const total = rows.reduce((sum, row) => sum + cardsOf(row), 0);
  const done = rows.reduce((sum, row) => sum + row.counts.done, 0);
  /** Puts the conversation's Goal in front of `before` among the project's Goals. */
  const move = (sessionId: string, before: string | null) => {
    setOrderError(null);
    order.mutate(
      { sessionId, before },
      { onError: (error) => setOrderError(editErrorText(error)) },
    );
  };

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
          <SheetTitle>
            <Trans>프로젝트 칸반 보드</Trans>
          </SheetTitle>
          <SheetDescription>
            {/* Muted labels, numbers in the foreground colour: the counts read at a glance
                without boxing every figure in a badge. The badge stays for "판단 대기" alone,
                the one figure that asks for action. */}
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                <Trans comment="Label before the number of conversations on the board">
                  실행 중인 대화
                </Trans>{" "}
                <span className="font-medium text-foreground tabular-nums">{rows.length}</span>
              </span>
              {running > 0 && (
                <span>
                  <Trans comment="Label before the number of conversations whose kanban loop runs">
                    칸반 실행
                  </Trans>{" "}
                  <span className="font-medium text-foreground tabular-nums">{running}</span>
                </span>
              )}
              <span>
                <Trans comment="Label before the finished and total card counts">완료</Trans>{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {done}/{total}
                </span>
              </span>
              {inbox.length + awaiting > 0 && (
                <Badge variant="outline">
                  <Trans comment="Badge: how many decisions wait for a person">
                    판단 대기 {ph({ count: inbox.length + awaiting })}
                  </Trans>
                </Badge>
              )}
            </span>
          </SheetDescription>
          {waiting.length > 0 && (
            <p role="status" className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted-foreground">
                <Trans comment="Followed by links to the conversations whose Plan is not executing">
                  실행 중이 아닌 Plan {ph({ count: waiting.length })}개:
                </Trans>
              </span>
              {waiting.map((row) => (
                <Button
                  key={row.sessionId}
                  type="button"
                  size="xs"
                  variant="link"
                  onClick={() => onOpenSession(row.sessionId)}
                >
                  {titleOf(row)} ({t(planStatusLabels[row.plan.status])})
                </Button>
              ))}
            </p>
          )}
          <Collapsible>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {rows.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  {/* Pressing it again keeps it pressed: every conversation is the resting state. */}
                  <Toggle
                    size="sm"
                    pressed={shown.length === 0}
                    onPressedChange={() => setShown([])}
                  >
                    <Trans comment="Filter that shows the cards of every conversation">
                      모든 대화
                    </Trans>
                  </Toggle>
                  <ToggleGroup
                    aria-label={t({
                      message: "보이는 대화",
                      comment: "Filter that picks the conversations whose cards are shown",
                    })}
                    multiple
                    size="sm"
                    spacing={1}
                    value={shown}
                    onValueChange={setShown}
                    className="flex-wrap"
                  >
                    {rows.map((row) => (
                      <ToggleGroupItem key={row.sessionId} value={row.sessionId}>
                        {titleOf(row)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              )}
              {/* Right after the filters, not pushed to the far edge: on a wide sheet a
                  justify-between row leaves these alone across an empty strip. Without filters
                  the ghost button's padding is pulled back so its chevron lines up with the title. */}
              <span className="flex items-center gap-1">
                {rows.length > 0 && (
                  <CollapsibleTrigger
                    render={
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={rows.length > 1 ? "group" : "group -ml-2"}
                      />
                    }
                  >
                    <ChevronRightIcon
                      data-icon="inline-start"
                      className="transition-transform group-data-[panel-open]:rotate-90"
                    />
                    <Trans>대화 순서와 상태</Trans>
                  </CollapsibleTrigger>
                )}
              </span>
            </div>
            {rows.length > 0 && (
              <CollapsibleContent className="mt-2 max-h-60 divide-y overflow-y-auto rounded-md border">
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  <Trans>
                    위쪽 대화의 카드부터 시작합니다. 카드 순서는 같은 대화 안에서 바꿉니다.
                  </Trans>
                </p>
                {rows.map((row, index) => (
                  <ConversationRow
                    key={row.sessionId}
                    projectId={projectId}
                    holder={holder}
                    row={row}
                    surface={surfaceOf(row.sessionId)}
                    decisions={
                      Arr.countBy(inbox, (item) => item.sessionId === row.sessionId) +
                      row.awaitingApproval.length
                    }
                    moving={order.isPending}
                    onMoveUp={
                      index === 0
                        ? null
                        : () => move(row.sessionId, rows[index - 1]?.sessionId ?? null)
                    }
                    onMoveDown={
                      index === rows.length - 1
                        ? null
                        : () => move(row.sessionId, rows[index + 2]?.sessionId ?? null)
                    }
                    onAdd={() => setAdding(row.sessionId)}
                    onOpenSession={() => onOpenSession(row.sessionId)}
                  />
                ))}
                {orderError !== null && (
                  <p className="px-3 py-2 text-xs text-destructive" role="alert">
                    {orderError}
                  </p>
                )}
              </CollapsibleContent>
            )}
          </Collapsible>
          {/* Drawn on the title row beside the sheet's close button (top-2 right-2, 24px wide):
              the keys belong to the whole board, not to the conversation filters. Last in the
              header so the sheet does not focus it first and open its tooltip; for the same
              reason it is left out while loading, when it would be the only control. */}
          {rows.length > 0 && (
            <span className="absolute top-2 right-9">
              <BoardShortcuts />
            </span>
          )}
        </SheetHeader>
        {boards.data === undefined && (
          <p className="px-4 text-muted-foreground">
            <Trans>보드를 불러오는 중입니다.</Trans>
          </p>
        )}
        {boards.data !== undefined && rows.length === 0 && (
          <p className="px-4 text-muted-foreground">
            <Trans>실행 중인 Plan이 없습니다. 대화에서 Plan을 실행하면 보드에 올라옵니다.</Trans>
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
 * One conversation's line in the board's status panel: its place among the project's Goals, its
 * Plan, its loop and the actions that belong to the whole Plan rather than to a card.
 */
function ConversationRow({
  projectId,
  holder,
  row,
  surface,
  decisions,
  moving,
  onMoveUp,
  onMoveDown,
  onAdd,
  onOpenSession,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly row: ProjectBoardRow;
  /** The conversation's board as the surface shows it; null until it has loaded. */
  readonly surface: SurfaceBoard | null;
  /** Decisions and card approvals waiting for the user. */
  readonly decisions: number;
  /** A move is on its way to the server. */
  readonly moving: boolean;
  /** Null at the top of the order. */
  readonly onMoveUp: (() => void) | null;
  /** Null at the bottom of the order. */
  readonly onMoveDown: (() => void) | null;
  readonly onAdd: () => void;
  readonly onOpenSession: () => void;
}) {
  const { t } = useLingui();
  const kanbanAction = useKanbanMutation(projectId, row.sessionId, holder);
  const [actionError, setActionError] = useState<string | null>(null);
  const title = titleOf(row);
  const loop = surface?.loop ?? null;
  const pendingChanges = surface?.view.pendingChanges.length ?? 0;
  const act = (action: KanbanAction) => {
    setActionError(null);
    kanbanAction.mutate(action, { onError: (error) => setActionError(editErrorText(error)) });
  };

  return (
    <section
      aria-label={t`${title} 대화`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs"
    >
      <span className="flex items-center">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t`${title} 위로`}
          disabled={moving || onMoveUp === null}
          onClick={() => onMoveUp?.()}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t`${title} 아래로`}
          disabled={moving || onMoveDown === null}
          onClick={() => onMoveDown?.()}
        >
          <ChevronDownIcon />
        </Button>
      </span>
      <h3 className="min-w-0 max-w-full truncate text-sm font-medium">{title}</h3>
      {row.kanbanActive ? (
        <Badge variant="secondary">
          <Trans comment="Badge: the kanban loop is running this Plan">칸반 실행 중</Trans>
        </Badge>
      ) : (
        <Badge variant="outline">{t(planStatusLabels[row.plan.status])}</Badge>
      )}
      {loop !== null && loop.plannerStalled && (
        <Badge
          variant="outline"
          title={t`Plan 작성자가 연속으로 카드를 고쳤지만 새로 충족된 결과가 없어 자동 Plan 작성을 멈췄습니다. 이미 맡은 카드는 계속 실행됩니다. 대화에서 방향을 알려 주면 다시 Plan을 짭니다.`}
        >
          <Trans comment="Badge: the automatic Plan writer has stopped">자동 Plan 작성 멈춤</Trans>
        </Badge>
      )}
      {loop !== null && loop.loop._tag !== "Healthy" && (
        <LoopHealthStatus
          label={t({
            message: "보드 루프",
            comment: "Name of the board loop in its health status",
          })}
          health={loop.loop}
          disabled={kanbanAction.isPending}
          onRestart={() => act(KanbanAction.RestartLoop())}
        />
      )}
      <span className="text-muted-foreground">
        <Trans comment="Finished cards out of all cards in the conversation's Plan">
          완료 {ph({ doneCount: row.counts.done })}/{ph({ cardCount: cardsOf(row) })}
        </Trans>
      </span>
      {decisions > 0 && (
        <Badge variant="outline">
          <Trans comment="Badge: how many decisions wait for a person">
            판단 대기 {ph({ count: decisions })}
          </Trans>
        </Badge>
      )}
      {pendingChanges > 0 && (
        <Badge variant="outline">
          <Trans comment="Badge: card change requests waiting for the orchestrator">
            변경 요청 대기 {ph({ pendingCount: pendingChanges })}
          </Trans>
        </Badge>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {loop === null && row.plan.status === "executing" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={t`카드마다 에이전트를 따로 두고 보드가 배정·검증·통합합니다. 이 대화의 모델은 카드를 직접 실행하지 않습니다.`}
            disabled={kanbanAction.isPending}
            onClick={() => act(KanbanAction.Start())}
          >
            <Trans comment="Button that hands the running Plan to the kanban loop">
              칸반으로 전환
            </Trans>
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={surface === null}
          onClick={onAdd}
        >
          <PlusIcon data-icon="inline-start" />
          <Trans comment="Button that opens the form for a new card in this conversation">
            카드 추가
          </Trans>
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onOpenSession}>
          <MessageSquareTextIcon data-icon="inline-start" />
          <Trans comment="Button that goes to the conversation">대화 열기</Trans>
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
