import { isTruthy } from "../../truthy.ts";
import { useState } from "react";
import { Array as Arr, Match, Order } from "effect";
import { ChevronRightIcon, CircleSlashIcon, KanbanSquareIcon, PlusIcon } from "lucide-react";
import { createSerializer, parseAsBoolean, parseAsString, useQueryStates } from "nuqs";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
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
  type CardStatus,
  type GoalMergeState,
  type HumanDecisionRequest,
  type KanbanScheduleView,
} from "../api";
import { useBoardQuery, useDecisionsQuery, useKanbanQuery } from "../queries/session";
import { DecisionPrompt } from "./decision-prompt";
import { metOutcomes, OutcomeChecklist } from "./outcome-checklist";
import { WorkflowRow, WorkflowRows } from "./workflow-rows";
import {
  KanbanAction,
  useBoardsEditMutation,
  useKanbanMutation,
} from "../queries/mutations/session";
import { koreanLocalTime } from "../shared/local-time";
import { LoopHealthStatus } from "../shared/loop-health";
import { cardStatusLabels } from "./board/board-moves";
import {
  BoardSurface,
  editErrorText,
  kanbanSwitchHint,
  plannerStalledHint,
  type ActiveKanban,
  type BoardPlan,
} from "./board/board-surface";
import { authorLabel, StatusIcon } from "./board/card-face";
import { verdictText } from "./board/hold-reason";
import { BoardShortcuts } from "./board/kanban-board";

export { cardStatusLabels } from "./board/board-moves";
export { authorLabel } from "./board/card-face";

/** Where the chat's board lives in the URL. Opening it closes the project board: one board per URL. */
const boardLocation = {
  board: parseAsBoolean,
  card: parseAsString,
  boards: parseAsBoolean,
  boardCard: parseAsString,
};
const boardLink = createSerializer(boardLocation);

function useBoardLocation() {
  const [location, setLocation] = useQueryStates(boardLocation);
  const openBoard = (card: string | null) =>
    void setLocation({ board: true, card, boards: null, boardCard: null });
  return { location, setLocation, openBoard };
}

/** Where a card stands in the chat's list once the Plan runs: what needs a look first. */
const attentionRanks: Readonly<Record<CardStatus, number>> = {
  human_decision: 0,
  blocked: 1,
  in_progress: 2,
  verify: 3,
  ready: 4,
  backlog: 5,
  done: 6,
};
const byAttention = Order.mapInput(
  Order.Number,
  ({ card }: BoardView["cards"][number]) => attentionRanks[card.status],
);

/** The workflow bar's numbers: cards done, outcomes met and decisions waiting for the user. */
export function BoardTally({
  projectId,
  sessionId,
}: {
  readonly projectId: string;
  readonly sessionId: string;
}) {
  const view = useBoardQuery(projectId, sessionId).data;
  const waiting = useDecisionsQuery(projectId, sessionId).data?.length ?? 0;
  if (!isTruthy(view)) return null;
  const done = Arr.countBy(view.cards, ({ card }) => card.status === "done");
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground tabular-nums">
      {view.plan !== null && (
        <span>
          카드 {done}/{view.cards.length}
        </span>
      )}
      {view.plan !== null && view.outcomes.length > 0 && <span aria-hidden>·</span>}
      {view.outcomes.length > 0 && (
        <span>
          결과 {metOutcomes(view.outcomes)}/{view.outcomes.length}
        </span>
      )}
      {waiting > 0 && <span className="text-warning">판단 대기 {waiting}</span>}
    </span>
  );
}

/**
 * Opens the Plan's board wide over the page (`?board=1`), at the card it last showed; a card opens
 * in a peek panel beside it (`?card=…`, as the inbox links and the card rows do). The board lives
 * here so it opens whether or not the bar is unfolded.
 */
export function OpenBoardButton({
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
  const view = useBoardQuery(projectId, sessionId).data;
  const decisions = useDecisionsQuery(projectId, sessionId).data ?? [];
  const kanban = useKanbanQuery(projectId, sessionId);
  const kanbanAction = useKanbanMutation(projectId, sessionId, holder);
  const { location, setLocation, openBoard } = useBoardLocation();
  if (!isTruthy(view) || view.plan === null) return null;
  const open = location.board === true || location.card !== null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => openBoard(location.card)}>
        <KanbanSquareIcon data-icon="inline-start" />
        보드
      </Button>
      {open && (
        <BoardSheet
          projectId={projectId}
          sessionId={sessionId}
          holder={holder}
          disabled={disabled}
          view={view}
          plan={view.plan}
          decisions={decisions}
          loop={kanban.data?.active === true ? kanban.data : null}
          kanbanAction={kanbanAction}
          peekCardId={location.card}
          onPeek={openBoard}
          onClose={() => void setLocation({ board: null, card: null })}
        />
      )}
    </>
  );
}

/**
 * The Plan's board as the unfolded workflow bar shows it: how the board's loop runs, the
 * outcomes and the cards, one line each.
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
  const kanban = useKanbanQuery(projectId, sessionId);
  const kanbanAction = useKanbanMutation(projectId, sessionId, holder);
  const { openBoard } = useBoardLocation();
  const [startError, setStartError] = useState<string | null>(null);

  const view = board.data;
  if (!isTruthy(view)) return <Skeleton aria-label="보드를 불러오는 중" className="h-6 w-full" />;
  const plan = view.plan;
  if (plan === null)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <OutcomeChecklist outcomes={view.outcomes} />
        <p className="px-1.5 text-muted-foreground">
          아직 카드가 없어요. 계획자가 Plan을 만들면 여기에 보여요.
        </p>
      </div>
    );
  const loop = kanban.data?.active === true ? kanban.data : null;
  const done = Arr.countBy(view.cards, ({ card }) => card.status === "done");
  const switchable = loop === null && plan.status === "executing";
  const reviewing = plan.status === "draft" || plan.status === "ready";
  // Read for approval, the cards keep the Plan's order; once running, what needs a look comes first.
  const cards = reviewing ? view.cards : Arr.sort(view.cards, byAttention);
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
    <div className="flex min-w-0 flex-col gap-2">
      {(loop !== null || switchable || view.pendingChanges.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-1.5">
          {loop !== null && <Badge variant="secondary">칸반 실행 중</Badge>}
          {loop !== null && loop.plannerStalled && (
            <Badge variant="outline" title={plannerStalledHint}>
              자동 계획 멈춤
            </Badge>
          )}
          {view.pendingChanges.length > 0 && (
            <Badge variant="outline">변경 요청 대기 {view.pendingChanges.length}</Badge>
          )}
          {loop !== null && loop.loop._tag !== "Healthy" && (
            <LoopHealthStatus
              label="보드 루프"
              health={loop.loop}
              disabled={disabled || kanbanAction.isPending}
              onRestart={restart}
            />
          )}
          {switchable && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              title={kanbanSwitchHint}
              disabled={disabled || kanbanAction.isPending}
              onClick={start}
            >
              칸반으로 전환
            </Button>
          )}
        </div>
      )}
      {startError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{startError}</AlertDescription>
        </Alert>
      )}
      <OutcomeChecklist outcomes={view.outcomes} />
      <WorkflowRows label={`카드 ${done}/${view.cards.length} 완료`}>
        {cards.map(({ card }) => (
          <WorkflowRow
            key={card.id}
            title={card.title}
            icon={<StatusIcon status={card.status} />}
            trailing={cardStatusLabels[card.status]}
            render={
              <a
                href={boardLink({ board: true, card: card.id })}
                onClick={(event) => {
                  // A modified click opens the card in a new tab as the link says.
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  openBoard(card.id);
                }}
              />
            }
          >
            {card.title}
          </WorkflowRow>
        ))}
      </WorkflowRows>
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
              {loop !== null && loop.plannerStalled && (
                <Badge variant="outline" title={plannerStalledHint}>
                  자동 계획 멈춤
                </Badge>
              )}
              {loop !== null && loop.loop._tag !== "Healthy" && (
                <LoopHealthStatus
                  label="보드 루프"
                  health={loop.loop}
                  disabled={disabled || kanbanAction.isPending}
                  onRestart={() => act(KanbanAction.RestartLoop())}
                />
              )}
              <span>
                완료 {Arr.countBy(view.cards, ({ card }) => card.status === "done")}/
                {view.cards.length}
              </span>
            </span>
          </SheetDescription>
          <Collapsible defaultOpen={goalDecisions.length > 0 || view.pendingChanges.length > 0}>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {loop === null && plan.status === "executing" && (
                <Button
                  type="button"
                  variant="outline"
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
              <span className="ml-auto flex items-center gap-1">
                {extras.length > 0 && (
                  <CollapsibleTrigger
                    render={<Button type="button" size="sm" variant="ghost" className="group" />}
                  >
                    <ChevronRightIcon
                      data-icon="inline-start"
                      className="transition-transform group-data-[panel-open]:rotate-90"
                    />
                    {extras.join(" · ")}
                    {goalDecisions.length > 0 && (
                      <Badge variant="outline">판단 대기 {goalDecisions.length}</Badge>
                    )}
                  </CollapsibleTrigger>
                )}
                <BoardShortcuts />
              </span>
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
              <CollapsibleContent className="mt-2 flex max-h-72 flex-col gap-3 overflow-y-auto rounded-md border px-3 py-2">
                {loop?.schedule != null && (
                  <GoalSchedulePanel
                    schedule={loop.schedule}
                    worktree={loop.mode === "worktree"}
                    decisions={goalDecisions}
                    projectId={projectId}
                    holder={holder}
                    disabled={disabled || kanbanAction.isPending}
                    onChange={act}
                  />
                )}
                {view.pendingChanges.length > 0 && (
                  <div className="flex flex-col gap-1" role="status">
                    <p className="font-medium">오케스트레이터 확인을 기다리는 변경</p>
                    <ul className="flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground">
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
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">보드 변경 이력</p>
                    <ol className="flex flex-col gap-0.5 text-xs text-muted-foreground">
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
            )}
          </Collapsible>
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
  worktree,
  decisions,
  projectId,
  holder,
  disabled,
  onChange,
}: {
  readonly schedule: KanbanScheduleView;
  /** Whether the cards run in worktrees off a Goal branch that can move to another target. */
  readonly worktree: boolean;
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
      className="flex flex-col gap-2 rounded-md border px-3 py-2 text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span>
          대상 브랜치: {schedule.targetBranch ?? "없음"} · {mergeStateLabel(schedule.merge)}
        </span>
        {schedule.upstreamPending && <Badge variant="outline">대상 브랜치 변경 반영 중</Badge>}
        {worktree && schedule.merge === null && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            title="프로젝트에 지금 checkout한 브랜치를 대상으로 삼고, Goal 브랜치를 그 브랜치에서 다시 시작해요. 카드 브랜치가 생기기 전에만 바꿀 수 있어요."
            disabled={disabled}
            onClick={() => onChange(KanbanAction.Retarget())}
          >
            현재 브랜치로 바꾸기
          </Button>
        )}
      </div>
      {schedule.waitingOn.length > 0 && (
        <p role="status">
          먼저 merge될 Goal을 기다리는 중: {schedule.waitingOn.map(goalName).join(", ")}. 그동안
          카드를 새로 시작하지 않아요.
        </p>
      )}
      {schedule.otherGoals.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">이 Goal보다 먼저 merge될 Goal</p>
          <ul className="flex flex-col gap-1">
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
