import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
import { loopHealthLabel, LoopHealthStatus } from "../shared/loop-health";
import {
  BoardSurface,
  editErrorText,
  startErrorText,
  type ActiveKanban,
  type BoardPlan,
} from "./board/board-surface";
import { cardStatusLabels } from "./board/board-moves";
import { authorLabel, StatusIcon } from "./board/card-face";
import { verdictText, waitsForUser } from "./board/hold-reason";
import { BoardShortcuts } from "./board/kanban-board";

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
/** A card awaiting the user's approval waits in backlog, yet asks for the user as a decision does. */
const awaitsApproval = ({ card }: BoardView["cards"][number]) => card.approval !== undefined;
const byAttention = Order.mapInput(Order.Number, (entry: BoardView["cards"][number]) =>
  awaitsApproval(entry) ? attentionRanks.human_decision : attentionRanks[entry.card.status],
);

/**
 * The workflow bar's numbers: cards done, outcomes met and decisions waiting for the user, and
 * what keeps the board from going on, so the folded bar shows a stopped or stuck board.
 */
export function BoardTally({
  projectId,
  sessionId,
}: {
  readonly projectId: string;
  readonly sessionId: string;
}) {
  const view = useBoardQuery(projectId, sessionId).data;
  const decisions = useDecisionsQuery(projectId, sessionId).data?.length ?? 0;
  const kanban = useKanbanQuery(projectId, sessionId).data;
  const { t } = useLingui();
  if (!isTruthy(view)) return null;
  const waiting = decisions + Arr.countBy(view.cards, awaitsApproval);
  const loop = kanban?.active === true ? kanban : null;
  const replanWaits =
    loop === null ? 0 : Arr.countBy(loop.cards, (card) => waitsForUser(card.reason));
  const pendingCount = view.pendingChanges.length;
  const done = Arr.countBy(view.cards, ({ card }) => card.status === "done");
  const cardCount = view.cards.length;
  const met = metOutcomes(view.outcomes);
  const outcomeCount = view.outcomes.length;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground tabular-nums">
      {view.plan !== null && (
        <span>
          <Trans comment="Workflow bar tally: cards done / all cards of the Plan">
            카드 {done}/{cardCount}
          </Trans>
        </span>
      )}
      {view.plan !== null && view.outcomes.length > 0 && <span aria-hidden>·</span>}
      {view.outcomes.length > 0 && (
        <span>
          <Trans comment="Workflow bar tally: outcomes met / all outcomes of the Goal">
            결과 {met}/{outcomeCount}
          </Trans>
        </span>
      )}
      {waiting > 0 && (
        <span className="text-warning">
          <Trans comment="Workflow bar tally: decisions waiting for the user">
            판단 대기 {waiting}
          </Trans>
        </span>
      )}
      {replanWaits > 0 && (
        <span className="text-warning">
          <Trans comment="Badge: blocked cards the planner did not replan, waiting for the user">
            확인 필요 카드 {replanWaits}
          </Trans>
        </span>
      )}
      {pendingCount > 0 && (
        <span>
          <Trans comment="Badge: card change requests waiting for the orchestrator">
            변경 요청 대기 {pendingCount}
          </Trans>
        </span>
      )}
      {loop !== null && loop.plannerStalled && (
        <span className="text-warning">
          <Trans comment="Badge: the automatic Plan writer has stopped">자동 Plan 작성 멈춤</Trans>
        </span>
      )}
      {loop !== null && loop.loop._tag !== "Healthy" && (
        <span className={loop.loop._tag === "Retrying" ? "text-warning" : "text-destructive"}>
          {t({
            message: "보드 루프",
            comment: "Name of the board loop in its health status",
          })}
          : {loopHealthLabel(loop.loop)}
        </span>
      )}
    </span>
  );
}

/** The cards whose replan the planner left undone: they wait for the user. */
function ReplanWaitBadge({ loop }: { readonly loop: ActiveKanban }) {
  const { t } = useLingui();
  const waiting = Arr.countBy(loop.cards, (card) => waitsForUser(card.reason));
  if (waiting === 0) return null;
  return (
    <Badge
      variant="outline"
      title={t`계속 실패해 다시 짜 달라고 요청한 카드를 Plan 작성자가 고치지 않았습니다. 카드를 고치거나 다시 대기열에 넣어 주십시오.`}
    >
      <Trans comment="Badge: blocked cards the planner did not replan, waiting for the user">
        확인 필요 카드 {waiting}
      </Trans>
    </Badge>
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
        <Trans comment="Button that opens the kanban board of the Plan">보드</Trans>
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
  const { t } = useLingui();
  const board = useBoardQuery(projectId, sessionId);
  const kanban = useKanbanQuery(projectId, sessionId);
  const kanbanAction = useKanbanMutation(projectId, sessionId, holder);
  const { openBoard } = useBoardLocation();
  const [startError, setStartError] = useState<string | null>(null);

  const view = board.data;
  if (!isTruthy(view))
    return <Skeleton aria-label={t`보드를 불러오는 중`} className="h-6 w-full" />;
  const plan = view.plan;
  if (plan === null)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <OutcomeChecklist outcomes={view.outcomes} />
        <p className="px-1.5 text-muted-foreground">
          <Trans>아직 카드가 없습니다. Plan 작성자가 Plan을 만들면 여기에 보입니다.</Trans>
        </p>
      </div>
    );
  const loop = kanban.data?.active === true ? kanban.data : null;
  const done = Arr.countBy(view.cards, ({ card }) => card.status === "done");
  const total = view.cards.length;
  const pendingCount = view.pendingChanges.length;
  const switchable = loop === null && plan.status === "executing";
  const reviewing = plan.status === "draft" || plan.status === "ready";
  // Read for approval, the cards keep the Plan's order; once running, what needs a look comes first.
  const cards = reviewing ? view.cards : Arr.sort(view.cards, byAttention);
  const start = () => {
    setStartError(null);
    kanbanAction.mutate(KanbanAction.Start(), {
      onError: (error) => setStartError(startErrorText(error)),
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
          {loop !== null && (
            <Badge variant="secondary">
              <Trans comment="Badge: the kanban loop is running this Plan">칸반 실행 중</Trans>
            </Badge>
          )}
          {loop !== null && loop.plannerStalled && (
            <Badge
              variant="outline"
              title={t`Plan 작성자가 연속으로 카드를 고쳤지만 새로 충족된 결과가 없어 자동 Plan 작성을 멈췄습니다. 이미 맡은 카드는 계속 실행됩니다. 대화에서 방향을 알려 주면 다시 Plan을 짭니다.`}
            >
              <Trans comment="Badge: the automatic Plan writer has stopped">
                자동 Plan 작성 멈춤
              </Trans>
            </Badge>
          )}
          {loop !== null && <ReplanWaitBadge loop={loop} />}
          {view.pendingChanges.length > 0 && (
            <Badge variant="outline">
              <Trans comment="Badge: card change requests waiting for the orchestrator">
                변경 요청 대기 {pendingCount}
              </Trans>
            </Badge>
          )}
          {loop !== null && loop.loop._tag !== "Healthy" && (
            <LoopHealthStatus
              label={t({
                message: "보드 루프",
                comment: "Name of the board loop in its health status",
              })}
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
              title={t`카드마다 에이전트를 따로 두고 보드가 배정·검증·통합합니다. 이 대화의 모델은 카드를 직접 실행하지 않습니다.`}
              disabled={disabled || kanbanAction.isPending}
              onClick={start}
            >
              <Trans comment="Button that hands the running Plan to the kanban loop">
                칸반으로 전환
              </Trans>
            </Button>
          )}
        </div>
      )}
      {startError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{startError}</AlertDescription>
        </Alert>
      )}
      <OutcomeChecklist
        outcomes={view.outcomes}
        unjudged={loop?.unjudgedOutcomes ?? []}
        recheck={{
          disabled: disabled || kanbanAction.isPending,
          onRecheck: () => {
            setStartError(null);
            kanbanAction.mutate(KanbanAction.RecheckOutcomes(), {
              onError: (error) => setStartError(editErrorText(error)),
            });
          },
        }}
      />
      <WorkflowRows label={t`카드 ${done}/${total} 완료`}>
        {cards.map(({ card }) => (
          <WorkflowRow
            key={card.id}
            title={card.title}
            icon={<StatusIcon status={card.status} />}
            trailing={
              card.approval !== undefined
                ? t({ message: "승인 대기", comment: "A card waiting for the user's approval" })
                : t(cardStatusLabels[card.status])
            }
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
  const { t } = useLingui();
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
  const goalDecisionCount = goalDecisions.length;
  // A Goal-level decision opened from the inbox names no card: the board opens with the Goal's
  // schedule and decisions unfolded instead.
  const goalAsked = peekCardId === goalDecisionCardId;
  const doneCount = Arr.countBy(view.cards, ({ card }) => card.status === "done");
  const cardCount = view.cards.length;
  // The folded panel is named after what it holds, not every part it could hold.
  const extras = [
    ...(loop?.schedule != null ? [t`Goal 스케줄`] : []),
    ...(view.pendingChanges.length > 0 ? [t`대기 중인 변경`] : []),
    ...(view.history.length > 0 ? [t`변경 이력`] : []),
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
          <SheetTitle>
            <Trans>칸반 보드</Trans>
          </SheetTitle>
          <SheetDescription>
            <span className="flex flex-wrap items-center gap-2">
              {loop !== null && (
                <Badge variant="secondary">
                  <Trans comment="Badge: the kanban loop is running this Plan">칸반 실행 중</Trans>
                </Badge>
              )}
              {loop !== null && loop.plannerStalled && (
                <Badge
                  variant="outline"
                  title={t`Plan 작성자가 연속으로 카드를 고쳤지만 새로 충족된 결과가 없어 자동 Plan 작성을 멈췄습니다. 이미 맡은 카드는 계속 실행됩니다. 대화에서 방향을 알려 주면 다시 Plan을 짭니다.`}
                >
                  <Trans comment="Badge: the automatic Plan writer has stopped">
                    자동 Plan 작성 멈춤
                  </Trans>
                </Badge>
              )}
              {loop !== null && <ReplanWaitBadge loop={loop} />}
              {loop !== null && loop.loop._tag !== "Healthy" && (
                <LoopHealthStatus
                  label={t({
                    message: "보드 루프",
                    comment: "Name of the board loop in its health status",
                  })}
                  health={loop.loop}
                  disabled={disabled || kanbanAction.isPending}
                  onRestart={() => act(KanbanAction.RestartLoop())}
                />
              )}
              <span>
                <Trans comment="Board sheet tally: cards done / all cards">
                  완료 {doneCount}/{cardCount}
                </Trans>
              </span>
            </span>
          </SheetDescription>
          <Collapsible
            defaultOpen={goalAsked || goalDecisions.length > 0 || view.pendingChanges.length > 0}
          >
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {loop === null && plan.status === "executing" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  title={t`카드마다 에이전트를 따로 두고 보드가 배정·검증·통합합니다. 이 대화의 모델은 카드를 직접 실행하지 않습니다.`}
                  disabled={disabled || kanbanAction.isPending}
                  onClick={() => {
                    setActionError(null);
                    kanbanAction.mutate(KanbanAction.Start(), {
                      onError: (error) => setActionError(startErrorText(error)),
                    });
                  }}
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
                disabled={disabled || closed}
                onClick={() => setAdding(true)}
              >
                <PlusIcon data-icon="inline-start" />
                <Trans>카드 추가</Trans>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || closed || edit.isPending}
                onClick={() => setAskClose(true)}
              >
                <CircleSlashIcon data-icon="inline-start" />
                <Trans comment="Button that closes the Plan at the user's request">Plan 닫기</Trans>
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
                      <Badge variant="outline">
                        <Trans comment="Badge: Goal decisions waiting for the user">
                          판단 대기 {goalDecisionCount}
                        </Trans>
                      </Badge>
                    )}
                  </CollapsibleTrigger>
                )}
                <BoardShortcuts />
              </span>
            </div>
            <Dialog open={askClose} onOpenChange={setAskClose}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    <Trans>이 Plan을 닫을까요?</Trans>
                  </DialogTitle>
                  <DialogDescription>
                    <Trans>
                      완료되지 않은 카드는 막힘으로 정리됩니다. 이 Plan은 칸반 보드 목록에서
                      사라집니다. 대화 기록과 지금까지 끝낸 카드는 그대로 남습니다.
                    </Trans>
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={edit.isPending}
                    onClick={() => setAskClose(false)}
                  >
                    <Trans comment="Dialog button: keep the Plan open">그만두기</Trans>
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={edit.isPending}
                    onClick={closePlan}
                  >
                    <Trans>사용자 요청으로 닫기</Trans>
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
                    <p className="font-medium">
                      <Trans>오케스트레이터 확인을 기다리는 변경</Trans>
                    </p>
                    <ul className="flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground">
                      {view.pendingChanges.map((request) => (
                        <li key={request.id}>
                          {titleOf(request.cardId)} ·{" "}
                          {Match.valueTags(request.change, {
                            Edit: () => <Trans>수정 요청</Trans>,
                            Cancel: () => <Trans>취소 요청</Trans>,
                          })}{" "}
                          · {koreanLocalTime(request.createdAt)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {view.history.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">
                      <Trans>보드 변경 이력</Trans>
                    </p>
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
          peek={peekCardId === null || goalAsked ? null : { sessionId, cardId: peekCardId }}
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
  no_target: msg`detached HEAD에서 시작해 브랜치가 없으므로 자동 merge하지 않습니다`,
  target_missing: msg`대상 브랜치가 없어졌습니다`,
  conflict_stopped: msg`충돌로 자동 merge를 멈췄습니다`,
  goal_replaced: msg`Goal 변경으로 merge를 멈췄습니다`,
} satisfies Record<
  Extract<GoalMergeState, { readonly _tag: "Stopped" }>["reason"],
  MessageDescriptor
>;

/** Where a Goal's merge into its target stands, in words. */
export function mergeStateLabel(state: GoalMergeState | null): MessageDescriptor {
  if (state === null) return msg`카드가 모두 끝난 뒤 merge합니다`;
  return Match.valueTags(state, {
    Verifying: () => msg`Goal 전체를 검증하는 중`,
    VerifyFailed: ({ verdict: failure }) => {
      const verdict = verdictText(failure);
      return msg`Goal 검증 실패: ${verdict}`;
    },
    WaitingWorktree: ({ worktree }) =>
      msg`작업 트리에 커밋하지 않은 변경이 있어 기다리는 중 (${worktree})`,
    TargetMoving: () => msg`대상 브랜치가 계속 바뀌어 다시 시도할 예정`,
    AwaitingDecision: () => msg`사람의 판단을 기다리는 중`,
    Merged: ({ commit: full }) => {
      const commit = full.slice(0, 8);
      return msg`merge됨 (${commit})`;
    },
    ManualMerge: () => msg`직접 merge하기로 함, Goal 브랜치를 남겨 둠`,
    PullRequestPending: () => msg`PR을 만드는 중`,
    PullRequestCreated: ({ url }) => msg`PR을 만듦: ${url}`,
    PullRequestUncertain: () =>
      msg`PR을 만들던 중 멈췄습니다. 원격 저장소에서 직접 확인해 주십시오`,
    PullRequestFailed: ({ stage }) =>
      stage === "push" ? msg`Goal 브랜치 push 실패` : msg`PR 생성 실패`,
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
  const { t } = useLingui();
  const goalName = (goalInstanceId: string) => {
    const goal = schedule.otherGoals.find((other) => other.goalInstanceId === goalInstanceId);
    return goal?.sessionTitle ?? goal?.statement ?? goalInstanceId.slice(0, 8);
  };
  const targetBranch =
    schedule.targetBranch ??
    t({ message: "없음", comment: "Target branch value when the Goal has no target branch" });
  const goals = schedule.waitingOn.map(goalName).join(", ");
  return (
    <section
      aria-label={t`Goal 스케줄`}
      className="flex flex-col gap-2 rounded-md border px-3 py-2 text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span>
          <Trans>대상 브랜치: {targetBranch}</Trans> · {t(mergeStateLabel(schedule.merge))}
        </span>
        {schedule.upstreamPending && (
          <Badge variant="outline">
            <Trans>대상 브랜치 변경 반영 중</Trans>
          </Badge>
        )}
        {worktree && schedule.merge === null && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            title={t`프로젝트에 지금 checkout한 브랜치를 대상으로 삼습니다. Goal 브랜치는 그 브랜치에서 다시 시작합니다. 카드 브랜치가 생기기 전에만 바꿀 수 있습니다.`}
            disabled={disabled}
            onClick={() => onChange(KanbanAction.Retarget())}
          >
            <Trans>현재 브랜치로 바꾸기</Trans>
          </Button>
        )}
      </div>
      {schedule.waitingOn.length > 0 && (
        <p role="status">
          <Trans>
            먼저 merge될 Goal을 기다리는 중: {goals}. 그동안 카드를 새로 시작하지 않습니다.
          </Trans>
        </p>
      )}
      {schedule.otherGoals.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">
            <Trans>이 Goal보다 먼저 merge될 Goal</Trans>
          </p>
          <ul className="flex flex-col gap-1">
            {schedule.otherGoals.map((other) => {
              const checked = schedule.dependsOn.includes(other.goalInstanceId);
              const goal = goalName(other.goalInstanceId);
              return (
                <li key={other.goalInstanceId} className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    checked={checked}
                    disabled={disabled}
                    aria-label={t({
                      message: `${goal} 먼저`,
                      comment: "Switch label: the named Goal merges before this Goal",
                    })}
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
                  <span className="text-xs">{t(mergeStateLabel(other.merge))}</span>
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
