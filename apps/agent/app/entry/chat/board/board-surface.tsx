import { useEffect, useState } from "react";
import { Effect, Fiber } from "effect";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  BoardEdit,
  BoardIntent,
  isApiError,
  type ApiErrorCode,
  type BoardView,
  type CardStatus as BoardCardStatus,
  type HumanDecisionRequest,
  type KanbanView,
} from "../../api";
import {
  KanbanAction,
  useEditBoardMutation,
  useKanbanMutation,
} from "../../queries/mutations/session";
import { PendingMove, withPending } from "./board-moves";
import type { CardSignals } from "./card-face";
import { CardPeek, Peek } from "./card-peek";
import { holdReasonText } from "./hold-reason";
import { KanbanBoard } from "./kanban-board";

export type ActiveKanban = Extract<KanbanView, { readonly active: true }>;
export type BoardPlan = NonNullable<BoardView["plan"]>;

export const errorText = (code: ApiErrorCode) => {
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
export const editErrorText = (error: Error) =>
  isApiError(error) ? errorText(error.code) : "보드를 바꾸지 못했어요.";

/** Where a dropped card is expected to land while its request is on the way. */
type Landing = { readonly cardId: string; readonly lands: BoardCardStatus };

/** The request in flight, read from the mutation that sends it. */
const pendingOf = (
  request: ReturnType<typeof useKanbanMutation>,
  landing: Landing | null,
  cards: BoardView["cards"],
): PendingMove | null => {
  if (!request.isPending || !KanbanAction.$is("Intent")(request.variables)) return null;
  const moved = ({ cardId }: { readonly cardId: string }) =>
    landing?.cardId === cardId ? PendingMove.Status({ cardId, to: landing.lands }) : null;
  return BoardIntent.$match(request.variables.intent, {
    Reorder: ({ cardId, at }) =>
      PendingMove.Order({ cardId, index: cards.findIndex(({ card }) => card.id === at) }),
    Hold: moved,
    Release: moved,
    Requeue: moved,
    ChangeRequest: () => null,
    Cancel: () => null,
  });
};

/**
 * One Plan's board surface: the columns with their cards, the card peek panel, the notice for a
 * refused request and the prompt for changing an executing card. The session's board sheet and
 * each lane of the project board draw one; the parent owns where it sits and which card is peeked.
 */
export function BoardSurface({
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
  adding,
  onAddingChange,
  onDraggingChange,
  className,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  readonly disabled: boolean;
  readonly view: BoardView;
  readonly plan: BoardPlan;
  readonly decisions: readonly HumanDecisionRequest[];
  readonly loop: ActiveKanban | null;
  /** The parent's kanban mutation, shared so its pending state disables the peek's actions too. */
  readonly kanbanAction: ReturnType<typeof useKanbanMutation>;
  readonly peekCardId: string | null;
  readonly onPeek: (cardId: string | null) => void;
  /** Whether the new card form is open; the parent's button opens it. */
  readonly adding: boolean;
  readonly onAddingChange: (adding: boolean) => void;
  /** Whether a card is picked up, so the parent's Esc then only puts it back. */
  readonly onDraggingChange: (dragging: boolean) => void;
  /** Sizes the columns' container: fill the parent, or grow with the cards up to a height. */
  readonly className: string;
}) {
  // Drops get their own mutation, so the board shows one as requested while it is on the way and
  // drops it when refused; the server's board then draws the card where it really is.
  const request = useKanbanMutation(projectId, sessionId, holder);
  const [landing, setLanding] = useState<Landing | null>(null);
  const edit = useEditBoardMutation(projectId, sessionId, holder);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [askChange, setAskChange] = useState<string | null>(null);
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
      kanbanAction.mutateAsync(KanbanAction.Intent({ intent: sent })).then(() => null);
    const editBoard = () => edit.mutateAsync(change).then(() => null);
    return BoardEdit.$match(change, {
      EditCard: ({ cardId, patch }) =>
        cards.find(({ card }) => card.id === cardId)?.card.status === "in_progress"
          ? intent(BoardIntent.ChangeRequest({ cardId, patch }))
          : editBoard(),
      CancelCard: ({ cardId }) => intent(BoardIntent.Cancel({ cardId })),
      AddCard: editBoard,
      MoveCard: editBoard,
    });
  };
  const peek: Peek | null = adding
    ? Peek.New()
    : peekCardId === null
      ? null
      : Peek.Card({ cardId: peekCardId, editing: editingCardId === peekCardId });
  /** The card the peek panel shows; null for a new card's form. */
  const peekedCardId =
    peek === null ? null : Peek.$match(peek, { New: () => null, Card: ({ cardId }) => cardId });

  return (
    <>
      <div className={className}>
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
            request.mutate(KanbanAction.Intent({ intent: BoardIntent.Reorder({ cardId, at }) }), {
              onError: refused,
            })
          }
          onSend={(cardId, intent, lands) => {
            setLanding({ cardId, lands });
            request.mutate(KanbanAction.Intent({ intent: BoardIntent[intent]({ cardId }) }), {
              onError: refused,
            });
          }}
          onAskChange={setAskChange}
          onRefused={setNotice}
          onDraggingChange={onDraggingChange}
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
          key={peekedCardId ?? "new"}
          peek={peek}
          entry={
            peekedCardId === null
              ? null
              : (cards.find(({ card }) => card.id === peekedCardId) ?? null)
          }
          loopCard={peekedCardId === null ? null : loopCard(peekedCardId)}
          decisions={peekedCardId === null ? [] : decisionsOf(peekedCardId)}
          titleOf={titleOf}
          changePending={peekedCardId !== null && changePending(peekedCardId)}
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
            kanbanAction.mutate(KanbanAction.Intent({ intent: BoardIntent[intent]({ cardId }) }), {
              onError: refused,
            })
          }
          onClose={() => {
            onAddingChange(false);
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
    </>
  );
}
