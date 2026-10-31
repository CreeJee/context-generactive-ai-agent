import { isTruthy } from "../../truthy.ts";
import { useState } from "react";
import { Match } from "effect";
import { ChevronRightIcon, CircleSlashIcon, KanbanSquareIcon, PlusIcon } from "lucide-react";
import { parseAsBoolean, parseAsString, useQueryStates } from "nuqs";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Switch } from "../../components/ui/switch";
import {
  BoardEdit,
  type BoardView,
  type GoalMergeState,
  type HumanDecisionRequest,
  type KanbanScheduleView,
} from "../api";
import { useBoardQuery, useDecisionsQuery, useKanbanQuery } from "../queries/session";
import { DecisionPrompt } from "./decision-prompt";
import {
  KanbanAction,
  useBoardsEditMutation,
  useKanbanMutation,
} from "../queries/mutations/session";
import { koreanLocalTime } from "../shared/local-time";
import { LoopHealthStatus } from "../shared/loop-health";
import { boardColumns, cardStatusLabels } from "./board/board-moves";
import {
  BoardSurface,
  editErrorText,
  kanbanSwitchHint,
  type ActiveKanban,
  type BoardPlan,
} from "./board/board-surface";
import { authorLabel, StatusIcon } from "./board/card-face";
import { verdictText } from "./board/hold-reason";

export { cardStatusLabels } from "./board/board-moves";
export { authorLabel } from "./board/card-face";

/**
 * The Plan's kanban board. The chat shows a summary of it; the board itself opens wide over the
 * page (`?board=1`), and a card opens in a peek panel beside it (`?card=…`, as the inbox links).
 */
export function WorkflowBoard({
  projectId,
  sessionId,
  holder,
  disabled,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  readonly disabled: boolean;
}) {
  const board = useBoardQuery(projectId, sessionId);
  const decisions = useDecisionsQuery(projectId, sessionId).data ?? [];
  const kanban = useKanbanQuery(projectId, sessionId);
  const kanbanAction = useKanbanMutation(projectId, sessionId, holder);
  // Opening this board closes the project board (`boards`, `boardCard`): one board per URL.
  const [location, setLocation] = useQueryStates({
    board: parseAsBoolean,
    card: parseAsString,
    boards: parseAsBoolean,
    boardCard: parseAsString,
  });
  const openBoard = (card: string | null) =>
    void setLocation({ board: true, card, boards: null, boardCard: null });
  const [startError, setStartError] = useState<string | null>(null);

  const view = board.data;
  if (!isTruthy(view)) return <p className="text-muted-foreground">보드를 불러오는 중이에요.</p>;
  const plan = view.plan;
  if (plan === null) return <p className="text-muted-foreground">아직 계획이 없어요.</p>;
  const loop = kanban.data?.active === true ? kanban.data : null;
  const total = view.cards.length;
  const done = view.cards.filter(({ card }) => card.status === "done").length;
  // The progress line already counts the finished cards; empty columns say nothing.
  const counts = boardColumns
    .filter((status) => status !== "done")
    .map((status) => ({
      status,
      count: view.cards.filter(({ card }) => card.status === status).length,
    }))
    .filter(({ count }) => count > 0);
  const waiting = decisions.length;
  const open = location.board === true || location.card !== null;
  const start = () => {
    setStartError(null);
    kanbanAction.mutate(KanbanAction.Start(), {
      onError: (error) => setStartError(editErrorText(error)),
    });
  };
  const restart = () => {
    setStartError(null);
    kanbanAction.mutate(KanbanAction.RestartLoop(), {
      onError: (error) => setStartError(editErrorText(error)),
    });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {loop !== null ? (
          <>
            <Badge variant="secondary">칸반 실행 중</Badge>
            {loop.loop._tag !== "Healthy" && (
              <LoopHealthStatus
                label="보드 루프"
                health={loop.loop}
                disabled={disabled || kanbanAction.isPending}
                onRestart={restart}
              />
            )}
          </>
        ) : (
          plan.status === "executing" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              title={kanbanSwitchHint}
              disabled={disabled || kanbanAction.isPending}
              onClick={start}
            >
              칸반으로 전환
            </Button>
          )
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => openBoard(location.card)}
        >
          <KanbanSquareIcon data-icon="inline-start" />
          보드 열기
        </Button>
      </div>
      {startError !== null && (
        <p className="text-destructive" role="alert">
          {startError}
        </p>
      )}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">
            완료 {done}/{total}
          </span>
          {waiting > 0 && <Badge variant="outline">판단 대기 {waiting}</Badge>}
          {view.pendingChanges.length > 0 && (
            <Badge variant="outline">변경 요청 대기 {view.pendingChanges.length}</Badge>
          )}
        </div>
        <div
          role="progressbar"
          aria-label="완료한 카드"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full w-(--board-progress) rounded-full bg-primary transition-all"
            style={{ "--board-progress": `${total === 0 ? 0 : (done / total) * 100}%` }}
          />
        </div>
        {counts.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {counts.map(({ status, count }) => (
              <li key={status} className="flex items-center gap-1">
                <StatusIcon status={status} />
                {cardStatusLabels[status]}
                <span className="font-medium text-foreground">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && (
        <BoardSheet
          projectId={projectId}
          sessionId={sessionId}
          holder={holder}
          disabled={disabled}
          view={view}
          plan={plan}
          decisions={decisions}
          loop={loop}
          kanbanAction={kanbanAction}
          peekCardId={location.card}
          onPeek={openBoard}
          onClose={() => void setLocation({ board: null, card: null })}
        />
      )}
    </div>
  );
}

/** The wide board over the page, with the card peek panel and the board's notices. */
function BoardSheet({
  projectId,
  sessionId,
  holder,
  disabled,
  view,
  plan,
  decisions,
  loop,
  kanbanAction,
  peekCardId,
  onPeek,
  onClose,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  readonly disabled: boolean;
  readonly view: BoardView;
  readonly plan: BoardPlan;
  readonly decisions: readonly HumanDecisionRequest[];
  readonly loop: ActiveKanban | null;
  readonly kanbanAction: ReturnType<typeof useKanbanMutation>;
  readonly peekCardId: string | null;
  readonly onPeek: (cardId: string | null) => void;
  readonly onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [askClose, setAskClose] = useState(false);
  const closed = plan.status === "completed" || plan.status === "closed";
  const edit = useBoardsEditMutation(holder)(projectId);
  const closePlan = () => {
    setActionError(null);
    setAskClose(false);
    edit.mutate(
      { sessionId, edit: BoardEdit.ClosePlan({ planVersion: plan.version }) },
      { onError: (error) => setActionError(editErrorText(error)) },
    );
  };
  const titleOf = (cardId: string) =>
    view.cards.find(({ card }) => card.id === cardId)?.card.title ?? cardId;
  const act = (action: KanbanAction) => {
    setActionError(null);
    kanbanAction.mutate(action, { onError: (error) => setActionError(editErrorText(error)) });
  };
  const goalDecisions = decisions.filter((request) => request.cardId === goalDecisionCardId);
  // The folded panel is named after what it holds, not every part it could hold.
  const extras = [
    ...(loop?.schedule != null ? ["Goal 스케줄"] : []),
    ...(view.pendingChanges.length > 0 ? ["대기 중인 변경"] : []),
    ...(view.history.length > 0 ? ["변경 이력"] : []),
  ];

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
          <SheetTitle>칸반 보드</SheetTitle>
          <SheetDescription>
            <span className="flex flex-wrap items-center gap-2">
              {loop !== null && <Badge variant="secondary">칸반 실행 중</Badge>}
              {loop !== null && loop.loop._tag !== "Healthy" && (
                <LoopHealthStatus
                  label="보드 루프"
                  health={loop.loop}
                  disabled={disabled || kanbanAction.isPending}
                  onRestart={() => act(KanbanAction.RestartLoop())}
                />
              )}
              <span>
                완료 {view.cards.filter(({ card }) => card.status === "done").length}/
                {view.cards.length}
              </span>
              <span className="hidden sm:inline">
                j·k·h·l로 카드 사이를 옮겨 다니고, Enter로 열어요. 손잡이에서 Space로 카드를 집어요.
              </span>
            </span>
          </SheetDescription>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {loop === null && plan.status === "executing" && (
              <Button
                type="button"
                size="sm"
                title={kanbanSwitchHint}
                disabled={disabled || kanbanAction.isPending}
                onClick={() => act(KanbanAction.Start())}
              >
                칸반으로 전환
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || closed}
              onClick={() => setAdding(true)}
            >
              <PlusIcon data-icon="inline-start" />
              카드 추가
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || closed || edit.isPending}
              onClick={() => setAskClose(true)}
            >
              <CircleSlashIcon data-icon="inline-start" />
              계획 닫기
            </Button>
            {actionError !== null && (
              <span className="text-destructive" role="alert">
                {actionError}
              </span>
            )}
          </div>
          <Dialog open={askClose} onOpenChange={setAskClose}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>이 계획을 닫을까요?</DialogTitle>
                <DialogDescription>
                  완료되지 않은 카드는 막힘으로 정리되고, 이 계획은 칸반 보드 목록에서 사라져요.
                  대화 기록과 지금까지 끝낸 카드는 그대로 남아요.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={edit.isPending}
                  onClick={() => setAskClose(false)}
                >
                  그만두기
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={edit.isPending}
                  onClick={closePlan}
                >
                  사용자 요청으로 닫기
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {extras.length > 0 && (
            <Collapsible
              className="rounded-md border"
              defaultOpen={goalDecisions.length > 0 || view.pendingChanges.length > 0}
            >
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]:rotate-90" />
                <span className="font-medium">{extras.join(" · ")}</span>
                {goalDecisions.length > 0 && (
                  <Badge variant="outline">판단 대기 {goalDecisions.length}</Badge>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="max-h-72 space-y-3 overflow-y-auto border-t px-3 py-2">
                {loop?.schedule != null && (
                  <GoalSchedulePanel
                    schedule={loop.schedule}
                    decisions={goalDecisions}
                    projectId={projectId}
                    holder={holder}
                    disabled={disabled || kanbanAction.isPending}
                    onChange={act}
                  />
                )}
                {view.pendingChanges.length > 0 && (
                  <div className="space-y-1" role="status">
                    <p className="font-medium">오케스트레이터 확인을 기다리는 변경</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                      {view.pendingChanges.map((request) => (
                        <li key={request.id}>
                          {titleOf(request.cardId)} ·{" "}
                          {Match.valueTags(request.change, {
                            Edit: () => "수정",
                            Cancel: () => "취소",
                          })}{" "}
                          요청 · {koreanLocalTime(request.createdAt)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {view.history.length > 0 && (
                  <div className="space-y-1">
                    <p className="font-medium">보드 변경 이력</p>
                    <ol className="space-y-0.5 text-xs text-muted-foreground">
                      {view.history.map((revision) => (
                        <li key={revision.revisionId}>
                          <Badge variant={revision.author === null ? "outline" : "secondary"}>
                            {authorLabel(revision.author)}
                          </Badge>{" "}
                          {koreanLocalTime(revision.at)} ·{" "}
                          {revision.detail || revision.cardIds.join(", ")}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          )}
        </SheetHeader>
        <BoardSurface
          projectId={projectId}
          holder={holder}
          disabled={disabled}
          boards={[{ sessionId, label: null, view, plan, decisions, loop, rank: null }]}
          shown={[]}
          peek={peekCardId === null ? null : { sessionId, cardId: peekCardId }}
          onPeek={(card) => onPeek(card === null ? null : card.cardId)}
          adding={adding ? sessionId : null}
          onAddingChange={(session) => setAdding(session !== null)}
          onDraggingChange={setDragging}
          className="min-h-0 flex-1 pt-3"
        />
      </SheetContent>
    </Sheet>
  );
}

/** The card id Goal-level requests carry (memory-agent `goalDecisionCardId`). */
const goalDecisionCardId = "@goal";

/** Why the scheduler stopped merging a Goal on its own. */
const stoppedMergeTexts = {
  no_target: "시작할 때 브랜치가 없어(detached HEAD) 자동 merge하지 않아요",
  target_missing: "대상 브랜치가 없어졌어요",
  conflict_stopped: "충돌로 자동 merge를 멈췄어요",
  goal_replaced: "Goal이 바뀌어 merge를 멈췄어요",
} as const;

/** Where a Goal's merge into its target stands, in words. */
export function mergeStateLabel(state: GoalMergeState | null): string {
  if (state === null) return "카드가 모두 끝나면 merge해요";
  return Match.valueTags(state, {
    Verifying: () => "Goal 전체를 검증하는 중",
    VerifyFailed: ({ verdict }) => `Goal 검증 실패: ${verdictText(verdict)}`,
    WaitingWorktree: ({ worktree }) =>
      `작업 트리에 커밋하지 않은 변경이 있어 기다리는 중 (${worktree})`,
    TargetMoving: () => "대상 브랜치가 계속 바뀌어 다시 시도할 예정",
    AwaitingDecision: () => "사람의 판단을 기다리는 중",
    Merged: ({ commit }) => `merge됨 (${commit.slice(0, 8)})`,
    ManualMerge: () => "직접 merge하기로 함, Goal 브랜치를 남겨 둠",
    PullRequestPending: () => "PR을 만드는 중",
    PullRequestCreated: ({ url }) => `PR을 만듦: ${url}`,
    PullRequestUncertain: () => "PR을 만들던 중 멈췄어요. 원격 저장소에서 직접 확인해 주세요",
    PullRequestFailed: ({ stage }) => (stage === "push" ? "Goal 브랜치 push 실패" : "PR 생성 실패"),
    Stopped: ({ reason }) => stoppedMergeTexts[reason],
  });
}

/** How the project scheduler runs this Goal: the Goals it waits for and its merge. */
function GoalSchedulePanel({
  schedule,
  decisions,
  projectId,
  holder,
  disabled,
  onChange,
}: {
  readonly schedule: KanbanScheduleView;
  readonly decisions: readonly HumanDecisionRequest[];
  readonly projectId: string;
  readonly holder: string;
  readonly disabled: boolean;
  readonly onChange: (action: KanbanAction) => void;
}) {
  const goalName = (goalInstanceId: string) => {
    const goal = schedule.otherGoals.find((other) => other.goalInstanceId === goalInstanceId);
    return goal?.sessionTitle ?? goal?.statement ?? goalInstanceId.slice(0, 8);
  };
  return (
    <section
      aria-label="Goal 스케줄"
      className="space-y-2 rounded-md border px-3 py-2 text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span>
          대상 브랜치: {schedule.targetBranch ?? "없음"} · {mergeStateLabel(schedule.merge)}
        </span>
        {schedule.upstreamPending && <Badge variant="outline">대상 브랜치 변경 반영 중</Badge>}
      </div>
      {schedule.waitingOn.length > 0 && (
        <p role="status">
          먼저 merge될 Goal을 기다리는 중: {schedule.waitingOn.map(goalName).join(", ")}. 그동안
          카드를 새로 시작하지 않아요.
        </p>
      )}
      {schedule.otherGoals.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-foreground">이 Goal보다 먼저 merge될 Goal</p>
          <ul className="space-y-1">
            {schedule.otherGoals.map((other) => {
              const checked = schedule.dependsOn.includes(other.goalInstanceId);
              return (
                <li key={other.goalInstanceId} className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    checked={checked}
                    disabled={disabled}
                    aria-label={`${goalName(other.goalInstanceId)} 먼저`}
                    onCheckedChange={(next) =>
                      onChange(
                        KanbanAction.SetDependencies({
                          dependsOn: next
                            ? [...schedule.dependsOn, other.goalInstanceId]
                            : schedule.dependsOn.filter((id) => id !== other.goalInstanceId),
                        }),
                      )
                    }
                  />
                  <span className="text-foreground">{goalName(other.goalInstanceId)}</span>
                  <span className="text-xs">{mergeStateLabel(other.merge)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {decisions.map((request) => (
        <DecisionPrompt
          key={request.requestId}
          projectId={projectId}
          holder={holder}
          request={request}
          disabled={disabled}
        />
      ))}
    </section>
  );
}
