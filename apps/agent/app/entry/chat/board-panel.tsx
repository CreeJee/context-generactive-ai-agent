import { isTruthy } from "../../truthy.ts";
import { useEffect, useState } from "react";
import { Effect, Fiber } from "effect";
import { ChevronRightIcon, KanbanSquareIcon, PlusIcon } from "lucide-react";
import { parseAsBoolean, parseAsString, useQueryStates } from "nuqs";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldLabel } from "../../components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Switch } from "../../components/ui/switch";
import {
  isApiError,
  type ApiErrorCode,
  type BoardEdit,
  type BoardIntent,
  type BoardView,
  type CardStatus as BoardCardStatus,
  type GoalMergeState,
  type GoalPriority,
  type HumanDecisionRequest,
  type KanbanScheduleView,
  type KanbanView,
} from "../api";
import { useBoardQuery, useDecisionsQuery, useKanbanQuery } from "../queries/session";
import { DecisionPrompt } from "./decision-prompt";
import {
  useEditBoardMutation,
  useKanbanMutation,
  type KanbanAction,
} from "../queries/mutations/session";
import { koreanLocalTime } from "../shared/local-time";
import { LoopHealthStatus } from "../shared/loop-health";
import { boardColumns, cardStatusLabels, withPending, type PendingMove } from "./board/board-moves";
import { authorLabel, StatusIcon, type CardSignals } from "./board/card-face";
import { CardPeek, type Peek } from "./board/card-peek";
import { KanbanBoard } from "./board/kanban-board";
import { holdReasonText, verdictText } from "./board/hold-reason";

export { cardStatusLabels } from "./board/board-moves";
export { authorLabel } from "./board/card-face";

const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "plan_version_conflict":
      return "그사이 계획이 바뀌었어요. 최신 보드를 다시 확인해 주세요.";
    case "plan_dependencies_rejected":
      return "의존 관계가 올바르지 않아요. 없는 카드나 순환 의존을 확인해 주세요.";
    case "card_finished":
      return "완료된 카드는 수정하거나 취소할 수 없어요.";
    case "card_missing":
      return "카드를 찾을 수 없어요.";
    case "card_status_changed":
      return "그사이 카드가 옮겨졌어요. 최신 보드를 다시 확인해 주세요.";
    case "card_transition_invalid":
      return "이 열로는 옮길 수 없어요.";
    case "card_not_waiting":
      return "시작하지 않은 카드만 보류할 수 있어요.";
    case "card_held":
      return "이미 보류한 카드예요.";
    case "card_not_held":
      return "보류하지 않은 카드예요.";
    case "card_not_blocked":
      return "막힌 카드만 다시 대기열에 넣을 수 있어요.";
    case "card_not_running":
      return "진행 중인 카드에만 수정 요청을 남길 수 있어요.";
    case "reorder_across_columns":
      return "순서는 같은 열 안에서만 바꿀 수 있어요.";
    case "not_kanban":
      return "칸반으로 실행할 때만 열을 옮길 수 있어요.";
    case "plan_closed":
      return "완료된 계획은 바꿀 수 없어요.";
    case "session_in_use":
      return "다른 창에서 이 대화를 쓰고 있어요.";
    case "plan_not_executing":
      return "실행 중인 계획만 칸반으로 돌릴 수 있어요.";
    case "worktree_unavailable":
      return "카드 작업 폴더를 만들 수 없어요.";
    case "dependency_cycle":
      return "서로 기다리는 Goal이 생겨서 지정할 수 없어요.";
    case "goal_missing":
    case "other_project":
    case "self_dependency":
      return "기다릴 수 없는 Goal이에요.";
    case "queue_item_changed":
      return "그사이 카드의 대기열 상태가 바뀌었어요. 최신 보드를 다시 확인해 주세요.";
    case "worktree_in_use":
      return "카드 작업 폴더를 다른 실행이 쓰고 있어요. 잠시 뒤 다시 시도해 주세요.";
    case "worktree_failed":
      return "카드 작업 폴더를 정리하지 못했어요.";
    case "kanban_storage_failed":
    case "workflow_storage_failed":
    case "schedule_storage_failed":
    case "storage_failed":
      return "보드를 저장하거나 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.";
    default:
      return "보드를 바꾸지 못했어요.";
  }
};
const holdText = (reason: Parameters<typeof holdReasonText>[0] | null) =>
  reason === null ? null : holdReasonText(reason);
const editErrorText = (error: Error) =>
  isApiError(error) ? errorText(error.code) : "보드를 바꾸지 못했어요.";

type ActiveKanban = Extract<KanbanView, { readonly active: true }>;
type BoardPlan = NonNullable<BoardView["plan"]>;

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
  const [location, setLocation] = useQueryStates({
    board: parseAsBoolean,
    card: parseAsString,
  });
  const [startError, setStartError] = useState<string | null>(null);

  const view = board.data;
  if (!isTruthy(view)) return <p className="text-muted-foreground">보드를 불러오는 중이에요.</p>;
  const plan = view.plan;
  if (plan === null) return <p className="text-muted-foreground">아직 계획이 없어요.</p>;
  const loop = kanban.data?.active === true ? kanban.data : null;
  const total = view.cards.length;
  const done = view.cards.filter(({ card }) => card.status === "done").length;
  const waiting = decisions.length;
  const open = location.board === true || location.card !== null;
  const start = () => {
    setStartError(null);
    kanbanAction.mutate(
      { _tag: "Start" },
      { onError: (error) => setStartError(editErrorText(error)) },
    );
  };
  const restart = () => {
    setStartError(null);
    kanbanAction.mutate(
      { _tag: "RestartLoop" },
      { onError: (error) => setStartError(editErrorText(error)) },
    );
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Plan v{plan.version}</span>
        {loop !== null ? (
          <>
            <Badge variant="secondary">칸반 실행 중</Badge>
            <LoopHealthStatus
              label="보드 루프"
              health={loop.loop}
              disabled={disabled || kanbanAction.isPending}
              onRestart={restart}
            />
          </>
        ) : (
          plan.status === "executing" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || kanbanAction.isPending}
              onClick={start}
            >
              칸반으로 실행
            </Button>
          )
        )}
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => void setLocation({ board: true })}
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
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {boardColumns.map((status) => (
            <li key={status} className="flex items-center gap-1">
              <StatusIcon status={status} />
              {cardStatusLabels[status]}
              <span className="font-medium text-foreground">
                {view.cards.filter(({ card }) => card.status === status).length}
              </span>
            </li>
          ))}
        </ul>
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
          onPeek={(card) => void setLocation({ board: true, card })}
          onClose={() => void setLocation({ board: null, card: null })}
        />
      )}
    </div>
  );
}

/** Where a dropped card is expected to land while its request is on the way. */
type Landing = { readonly cardId: string; readonly lands: BoardCardStatus };

/** The request in flight, read from the mutation that sends it. */
const pendingOf = (
  request: ReturnType<typeof useKanbanMutation>,
  landing: Landing | null,
  cards: BoardView["cards"],
): PendingMove | null => {
  if (!request.isPending || request.variables?._tag !== "Intent") return null;
  const intent = request.variables.intent;
  switch (intent._tag) {
    case "Reorder":
      return {
        _tag: "Order",
        cardId: intent.cardId,
        index: cards.findIndex(({ card }) => card.id === intent.at),
      };
    case "Hold":
    case "Release":
    case "Requeue":
      return landing?.cardId === intent.cardId
        ? { _tag: "Status", cardId: intent.cardId, to: landing.lands }
        : null;
    case "ChangeRequest":
    case "Cancel":
      return null;
  }
};

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
  // Drops get their own mutation, so the board shows one as requested while it is on the way and
  // drops it when refused; the server's board then draws the card where it really is.
  const request = useKanbanMutation(projectId, sessionId, holder);
  const [landing, setLanding] = useState<Landing | null>(null);
  const edit = useEditBoardMutation(projectId, sessionId, holder);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [askChange, setAskChange] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (notice === null) return;
    const dismiss = Effect.runFork(
      Effect.sleep("5 seconds").pipe(Effect.andThen(Effect.sync(() => setNotice(null)))),
    );
    return () => void Effect.runFork(Fiber.interrupt(dismiss));
  }, [notice]);

  const closed = plan.status === "completed";
  const pending = pendingOf(request, landing, view.cards);
  const cards = withPending(view.cards, pending);
  const titleOf = (cardId: string) =>
    view.cards.find(({ card }) => card.id === cardId)?.card.title ?? cardId;
  const loopCard = (cardId: string) => loop?.cards.find((card) => card.cardId === cardId) ?? null;
  const decisionsOf = (cardId: string) => decisions.filter((request) => request.cardId === cardId);
  const changePending = (cardId: string) =>
    view.pendingChanges.some((request) => request.cardId === cardId);
  const signalsOf = (cardId: string): CardSignals => ({
    decisionPending: decisionsOf(cardId).length > 0,
    changePending: changePending(cardId),
    requesting: pending?.cardId === cardId,
    reason: holdText(loopCard(cardId)?.reason ?? null),
    dependsOn: (cards.find(({ card }) => card.id === cardId)?.card.dependsOn ?? []).map(titleOf),
  });
  const refused = (error: Error) => setNotice(editErrorText(error));
  /** A change to an executing card is a request, and cancelling stops the card: both intents. */
  const save = (change: BoardEdit): Promise<null> => {
    const intent = (sent: BoardIntent) =>
      kanbanAction.mutateAsync({ _tag: "Intent", intent: sent }).then(() => null);
    switch (change._tag) {
      case "EditCard":
        return cards.find(({ card }) => card.id === change.cardId)?.card.status === "in_progress"
          ? intent({ _tag: "ChangeRequest", cardId: change.cardId, patch: change.patch })
          : edit.mutateAsync(change).then(() => null);
      case "CancelCard":
        return intent({ _tag: "Cancel", cardId: change.cardId });
      case "AddCard":
      case "MoveCard":
        return edit.mutateAsync(change).then(() => null);
    }
  };
  const peek: Peek | null = adding
    ? { _tag: "New" }
    : peekCardId === null
      ? null
      : { _tag: "Card", cardId: peekCardId, editing: editingCardId === peekCardId };
  const goalDecisions = decisionsOf(goalDecisionCardId);

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
              <span>Plan v{plan.version}</span>
              {loop !== null && <Badge variant="secondary">칸반 실행 중</Badge>}
              {loop !== null && (
                <LoopHealthStatus
                  label="보드 루프"
                  health={loop.loop}
                  disabled={disabled || kanbanAction.isPending}
                  onRestart={() =>
                    kanbanAction.mutate({ _tag: "RestartLoop" }, { onError: refused })
                  }
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
                disabled={disabled || kanbanAction.isPending}
                onClick={() => kanbanAction.mutate({ _tag: "Start" }, { onError: refused })}
              >
                칸반으로 실행
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
          </div>
          {(loop?.schedule != null ||
            view.pendingChanges.length > 0 ||
            view.history.length > 0) && (
            <Collapsible
              className="rounded-md border"
              defaultOpen={goalDecisions.length > 0 || view.pendingChanges.length > 0}
            >
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]:rotate-90" />
                <span className="font-medium">Goal 스케줄 · 대기 중인 변경 · 이력</span>
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
                    onChange={(action) => kanbanAction.mutate(action, { onError: refused })}
                  />
                )}
                {view.pendingChanges.length > 0 && (
                  <div className="space-y-1" role="status">
                    <p className="font-medium">오케스트레이터 확인을 기다리는 변경</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                      {view.pendingChanges.map((request) => (
                        <li key={request.id}>
                          {titleOf(request.cardId)} ·{" "}
                          {request.change._tag === "Edit" ? "수정" : "취소"} 요청 ·{" "}
                          {koreanLocalTime(request.createdAt)}
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
        <div className="min-h-0 flex-1 pt-3">
          <KanbanBoard
            cards={cards}
            signalsOf={signalsOf}
            context={{
              cards: cards.map(({ card }) => card),
              kanbanActive: loop !== null,
              closed,
            }}
            disabled={disabled}
            busy={request.isPending}
            onOpen={(cardId) => onPeek(cardId)}
            onReorder={(cardId, at) =>
              request.mutate(
                { _tag: "Intent", intent: { _tag: "Reorder", cardId, at } },
                { onError: refused },
              )
            }
            onSend={(cardId, intent, lands) => {
              setLanding({ cardId, lands });
              request.mutate(
                { _tag: "Intent", intent: { _tag: intent, cardId } },
                { onError: refused },
              );
            }}
            onAskChange={setAskChange}
            onRefused={setNotice}
            onDraggingChange={setDragging}
          />
        </div>
        {notice !== null && (
          <Alert
            variant="destructive"
            className="fixed right-4 bottom-4 left-4 z-50 w-auto sm:left-auto sm:max-w-sm"
          >
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {peek !== null && (
          <CardPeek
            key={peek._tag === "Card" ? peek.cardId : "new"}
            peek={peek}
            entry={
              peek._tag === "Card"
                ? (cards.find(({ card }) => card.id === peek.cardId) ?? null)
                : null
            }
            loopCard={peek._tag === "Card" ? loopCard(peek.cardId) : null}
            decisions={peek._tag === "Card" ? decisionsOf(peek.cardId) : []}
            titleOf={titleOf}
            changePending={peek._tag === "Card" && changePending(peek.cardId)}
            projectId={projectId}
            holder={holder}
            disabled={disabled}
            closed={closed}
            planVersion={plan.version}
            cardCount={view.cards.length}
            editPending={edit.isPending || kanbanAction.isPending}
            intentPending={kanbanAction.isPending}
            kanbanActive={loop !== null}
            onEdit={(editing) => setEditingCardId(editing ? peekCardId : null)}
            onIntent={(intent, cardId) =>
              kanbanAction.mutate(
                { _tag: "Intent", intent: { _tag: intent, cardId } },
                { onError: refused },
              )
            }
            onClose={() => {
              setAdding(false);
              setEditingCardId(null);
              onPeek(null);
            }}
            onSubmit={(change) => save(change).catch((error: Error) => editErrorText(error))}
          />
        )}
        <Dialog
          open={askChange !== null}
          onOpenChange={(next) => {
            if (!next) setAskChange(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>진행 중인 카드예요</DialogTitle>
              <DialogDescription>
                진행 중인 카드는 오케스트레이터가 옮겨요. 바꾸고 싶은 내용을 수정 요청으로 남기면
                오케스트레이터가 반영할지 정해요.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAskChange(null)}>
                그대로 두기
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setEditingCardId(askChange);
                  onPeek(askChange);
                  setAskChange(null);
                }}
              >
                수정 요청 남기기
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

/** The card id Goal-level requests carry (memory-agent `goalDecisionCardId`). */
const goalDecisionCardId = "@goal";

const priorityItems = [
  { value: "high", label: "높음" },
  { value: "normal", label: "보통" },
  { value: "low", label: "낮음" },
] as const satisfies ReadonlyArray<{ readonly value: GoalPriority; readonly label: string }>;

/** Where a Goal's merge into its target stands, in words. */
export function mergeStateLabel(state: GoalMergeState | null): string {
  if (state === null) return "카드가 모두 끝나면 merge해요";
  switch (state._tag) {
    case "Verifying":
      return "Goal 전체를 검증하는 중";
    case "VerifyFailed":
      return `Goal 검증 실패: ${verdictText(state.verdict)}`;
    case "WaitingWorktree":
      return `작업 트리에 커밋하지 않은 변경이 있어 기다리는 중 (${state.worktree})`;
    case "TargetMoving":
      return "대상 브랜치가 계속 바뀌어 다시 시도할 예정";
    case "AwaitingDecision":
      return "사람의 판단을 기다리는 중";
    case "Merged":
      return `merge됨 (${state.commit.slice(0, 8)})`;
    case "ManualMerge":
      return "직접 merge하기로 함, Goal 브랜치를 남겨 둠";
    case "PullRequestPending":
      return "PR을 만드는 중";
    case "PullRequestCreated":
      return `PR을 만듦: ${state.url}`;
    case "PullRequestUncertain":
      return "PR을 만들던 중 멈췄어요. 원격 저장소에서 직접 확인해 주세요";
    case "PullRequestFailed":
      return state.stage === "push" ? "Goal 브랜치 push 실패" : "PR 생성 실패";
    case "Stopped":
      switch (state.reason) {
        case "no_target":
          return "시작할 때 브랜치가 없어(detached HEAD) 자동 merge하지 않아요";
        case "target_missing":
          return "대상 브랜치가 없어졌어요";
        case "conflict_stopped":
          return "충돌로 자동 merge를 멈췄어요";
        case "goal_replaced":
          return "Goal이 바뀌어 merge를 멈췄어요";
      }
  }
}

/** How the project scheduler runs this Goal: its priority, the Goals it waits for, its merge. */
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
        <Field orientation="horizontal" className="w-auto">
          <FieldLabel htmlFor="goal-priority">Goal 우선순위</FieldLabel>
          <Select
            value={schedule.priority}
            items={priorityItems}
            disabled={disabled}
            onValueChange={(value) => {
              const item = priorityItems.find((option) => option.value === value);
              if (isTruthy(item)) onChange({ _tag: "SetPriority", priority: item.value });
            }}
          >
            <SelectTrigger id="goal-priority" size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {priorityItems.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
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
                      onChange({
                        _tag: "SetDependencies",
                        dependsOn: next
                          ? [...schedule.dependsOn, other.goalInstanceId]
                          : schedule.dependsOn.filter((id) => id !== other.goalInstanceId),
                      })
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
