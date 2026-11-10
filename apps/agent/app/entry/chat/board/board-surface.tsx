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
  useBoardsEditMutation,
  useBoardsKanbanMutation,
} from "../../queries/mutations/session";
import { problemText } from "../../shared/copy-templates";
import {
  boardCardKey,
  boardItem,
  inProjectOrder,
  PendingMove,
  withPending,
  type BoardCardRef,
  type BoardItem,
  type DropContext,
} from "./board-moves";
import type { CardSignals } from "./card-face";
import { CardPeek, Peek, type TransferTarget } from "./card-peek";
import { boardCopy } from "./copy";
import { holdReasonText } from "./hold-reason";
import { KanbanBoard } from "./kanban-board";

export type ActiveKanban = Extract<KanbanView, { readonly active: true }>;
export type BoardPlan = NonNullable<BoardView["plan"]>;

/** One Plan on the surface: a conversation's board with its loop and its waiting decisions. */
export interface SurfaceBoard {
  readonly sessionId: string;
  /** The conversation's name on its cards and in the peek; null when the surface shows one Plan. */
  readonly label: string | null;
  readonly view: BoardView;
  readonly plan: BoardPlan;
  readonly decisions: readonly HumanDecisionRequest[];
  readonly loop: ActiveKanban | null;
  /**
   * The conversation's place among the project's Goals, from the project's board list; null when
   * the surface shows one Plan.
   */
  readonly rank: number | null;
}

const { errors } = boardCopy;
export const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "plan_version_conflict":
      return problemText(errors.plan_version_conflict);
    case "plan_dependencies_rejected":
      return problemText(errors.plan_dependencies_rejected);
    case "plan_outcomes_rejected":
      return problemText(errors.plan_outcomes_rejected);
    case "card_finished":
      return errors.card_finished;
    case "card_missing":
      return errors.card_missing;
    case "card_status_changed":
      return problemText(errors.card_status_changed);
    case "card_transition_invalid":
      return errors.card_transition_invalid;
    case "card_not_waiting":
      return errors.card_not_waiting;
    case "card_held":
      return errors.card_held;
    case "card_not_held":
      return errors.card_not_held;
    case "card_not_pending":
      return errors.card_not_pending;
    case "card_not_blocked":
      return errors.card_not_blocked;
    case "card_not_running":
      return errors.card_not_running;
    case "card_running":
      return problemText(errors.card_running);
    case "card_waiting":
      return errors.card_waiting;
    case "card_has_dependents":
      return problemText(errors.card_has_dependents);
    case "transfer_target_invalid":
      return errors.transfer_target_invalid;
    case "not_worktree":
      return errors.not_worktree;
    case "merge_started":
      return errors.merge_started;
    case "detached_head":
      return problemText(errors.detached_head);
    case "goal_has_work":
      return errors.goal_has_work;
    case "cards_started":
      return errors.cards_started;
    case "reorder_across_columns":
      return errors.reorder_across_columns;
    case "not_kanban":
      return errors.not_kanban;
    case "plan_closed":
      return errors.plan_closed;
    case "session_in_use":
      return errors.session_in_use;
    case "plan_not_executing":
      return errors.plan_not_executing;
    case "worktree_unavailable":
      return errors.worktree_unavailable;
    case "dependency_cycle":
      return errors.dependency_cycle;
    case "goal_missing":
    case "other_project":
    case "self_dependency":
      return errors.goal_unwaitable;
    case "queue_item_changed":
      return problemText(errors.queue_item_changed);
    case "worktree_in_use":
      return problemText(errors.worktree_in_use);
    case "worktree_failed":
      return errors.worktree_failed;
    case "kanban_storage_failed":
    case "workflow_storage_failed":
    case "schedule_storage_failed":
    case "storage_failed":
      return problemText(errors.storage_failed);
    default:
      return errors.unknown;
  }
};
const holdText = (reason: Parameters<typeof holdReasonText>[0] | null) =>
  reason === null ? null : holdReasonText(reason);
export const editErrorText = (error: Error) =>
  isApiError(error) ? errorText(error.code) : errors.unknown;

/** Where a dropped card is expected to land while its request is on the way. */
type Landing = { readonly key: string; readonly lands: BoardCardStatus };

/** The request in flight, read from the mutation that sends it. */
const pendingOf = (
  request: ReturnType<typeof useBoardsKanbanMutation>,
  landing: Landing | null,
  items: readonly BoardItem[],
): PendingMove | null => {
  const sent = request.variables;
  if (!request.isPending || sent === undefined || !KanbanAction.$is("Intent")(sent.action))
    return null;
  const keyOf = (cardId: string) => boardCardKey({ sessionId: sent.sessionId, cardId });
  const moved = ({ cardId }: { readonly cardId: string }) =>
    landing?.key === keyOf(cardId)
      ? PendingMove.Status({ key: keyOf(cardId), to: landing.lands })
      : null;
  return BoardIntent.$match(sent.action.intent, {
    Reorder: ({ cardId, at }) =>
      PendingMove.Order({
        key: keyOf(cardId),
        index: items.findIndex((item) => item.key === keyOf(at)),
      }),
    Hold: moved,
    Release: moved,
    Approve: () => null,
    Requeue: moved,
    ChangeRequest: () => null,
    Cancel: () => null,
    Transfer: ({ cardId }) => PendingMove.Leaving({ key: keyOf(cardId) }),
  });
};

const refOf = (item: BoardItem): BoardCardRef => ({
  sessionId: item.sessionId,
  cardId: item.card.id,
});

/**
 * The board surface: the columns with the cards of one or several Plans, the card peek panel, the
 * notice for a refused request, and the prompts for changing an executing card and for moving a
 * card to another conversation. The session's board sheet shows one Plan on it; the project board
 * shows every Plan of the project. The parent owns where it sits and which card is peeked.
 */
export function BoardSurface({
  projectId,
  holder,
  disabled,
  boards,
  shown,
  peek,
  onPeek,
  adding,
  onAddingChange,
  onDraggingChange,
  className,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly disabled: boolean;
  /** The Plans on the board, in the order their cards are laid out. */
  readonly boards: readonly SurfaceBoard[];
  /** The conversations whose cards are shown; empty shows them all. A card can still move to a hidden one. */
  readonly shown: readonly string[];
  readonly peek: BoardCardRef | null;
  readonly onPeek: (card: BoardCardRef | null) => void;
  /** The conversation whose new card form is open; the parent's button opens it. */
  readonly adding: string | null;
  readonly onAddingChange: (sessionId: string | null) => void;
  /** Whether a card is picked up, so the parent's Esc then only puts it back. */
  readonly onDraggingChange: (dragging: boolean) => void;
  /** Sizes the columns' container: fill the parent, or grow with the cards up to a height. */
  readonly className: string;
}) {
  // Drops and transfers get their own mutation, so the board shows one as requested while it is on
  // the way and drops it when refused; the server's board then draws the card where it really is.
  const request = useBoardsKanbanMutation(projectId, holder);
  // The peek's own actions: their pending state disables the peek, not the board.
  const action = useBoardsKanbanMutation(projectId, holder);
  const edit = useBoardsEditMutation(projectId, holder);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [askChange, setAskChange] = useState<BoardItem | null>(null);
  const [transfer, setTransfer] = useState<{ item: BoardItem; to: SurfaceBoard } | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const dismiss = Effect.runFork(
      Effect.sleep("5 seconds").pipe(Effect.andThen(Effect.sync(() => setNotice(null)))),
    );
    return () => void Effect.runFork(Fiber.interrupt(dismiss));
  }, [notice]);

  const boardOf = (sessionId: string) =>
    boards.find((board) => board.sessionId === sessionId) ?? null;
  const closedIn = (board: SurfaceBoard) =>
    board.plan.status === "completed" || board.plan.status === "closed";
  const visible = boards.filter((board) => shown.length === 0 || shown.includes(board.sessionId));
  const items = inProjectOrder(
    visible.flatMap((board) =>
      board.view.cards.map((entry) => ({
        item: boardItem(board.sessionId, entry),
        rank: board.rank,
      })),
    ),
  );
  const pending = pendingOf(request, landing, items);
  const cards = withPending(items, pending);
  const itemOf = (ref: BoardCardRef) =>
    cards.find((item) => item.key === boardCardKey(ref)) ?? null;
  const titleIn = (sessionId: string) => (cardId: string) =>
    boardOf(sessionId)?.view.cards.find(({ card }) => card.id === cardId)?.card.title ?? cardId;
  const outcomeIn = (sessionId: string) => (outcomeId: string) =>
    boardOf(sessionId)?.view.outcomes.find((outcome) => outcome.id === outcomeId)?.text ?? null;
  const doneIn = (sessionId: string, cardId: string) =>
    boardOf(sessionId)?.view.cards.find(({ card }) => card.id === cardId)?.card.status === "done";
  const loopCard = (ref: BoardCardRef) =>
    boardOf(ref.sessionId)?.loop?.cards.find((card) => card.cardId === ref.cardId) ?? null;
  const decisionsOf = (ref: BoardCardRef) =>
    boardOf(ref.sessionId)?.decisions.filter((waiting) => waiting.cardId === ref.cardId) ?? [];
  const changePending = (ref: BoardCardRef) =>
    boardOf(ref.sessionId)?.view.pendingChanges.some((change) => change.cardId === ref.cardId) ??
    false;
  const signalsOf = (item: BoardItem): CardSignals => ({
    decisionPending: decisionsOf(refOf(item)).length > 0,
    changePending: changePending(refOf(item)),
    requesting: pending?.key === item.key,
    reason: holdText(loopCard(refOf(item))?.reason ?? null),
    // Only a card that has not started waits for anything; a started one is past its prerequisites.
    waitingOn:
      item.card.status === "backlog" || item.card.status === "ready"
        ? item.card.dependsOn
            .filter((cardId) => !doneIn(item.sessionId, cardId))
            .map(titleIn(item.sessionId))
        : [],
    // With one conversation on screen every card would name the same one.
    group: visible.length > 1 ? (boardOf(item.sessionId)?.label ?? null) : null,
  });
  const contextOf = (item: BoardItem): DropContext => {
    const board = boardOf(item.sessionId);
    return {
      cards: cards.filter((other) => other.sessionId === item.sessionId).map(({ card }) => card),
      kanbanActive: board !== null && board.loop !== null,
      closed: board === null || closedIn(board),
    };
  };
  const refused = (error: Error) => setNotice(editErrorText(error));
  const intent = (sessionId: string, sent: BoardIntent) =>
    action
      .mutateAsync({ sessionId, action: KanbanAction.Intent({ intent: sent }) })
      .then(() => null);
  /** A change to an executing card is a request, and cancelling stops the card: both intents. */
  const save = (sessionId: string, change: BoardEdit): Promise<null> => {
    const editBoard = () => edit.mutateAsync({ sessionId, edit: change }).then(() => null);
    return BoardEdit.$match(change, {
      EditCard: ({ cardId, patch }) =>
        itemOf({ sessionId, cardId })?.card.status === "in_progress"
          ? intent(sessionId, BoardIntent.ChangeRequest({ cardId, patch }))
          : editBoard(),
      CancelCard: ({ cardId }) => intent(sessionId, BoardIntent.Cancel({ cardId })),
      AddCard: editBoard,
      MoveCard: editBoard,
      ClosePlan: editBoard,
    });
  };
  /** The card leaves for the other Plan's end; the peek closes once it has. */
  const sendTransfer = ({ item, to }: { readonly item: BoardItem; readonly to: SurfaceBoard }) => {
    setTransfer(null);
    request.mutate(
      {
        sessionId: item.sessionId,
        action: KanbanAction.Intent({
          intent: BoardIntent.Transfer({
            cardId: item.card.id,
            toSessionId: to.sessionId,
            at: null,
          }),
        }),
      },
      { onError: refused, onSuccess: () => onPeek(null) },
    );
  };

  /** The conversation the peek panel is about: the new card's, or the peeked card's. */
  const peekSession = adding ?? peek?.sessionId ?? null;
  const peekBoard = peekSession === null ? null : boardOf(peekSession);
  const peekState: Peek | null =
    adding !== null
      ? Peek.New()
      : peek === null
        ? null
        : Peek.Card({ cardId: peek.cardId, editing: editingKey === boardCardKey(peek) });
  const peeked = adding !== null || peek === null ? null : itemOf(peek);
  const peekKey = adding !== null ? `new:${adding}` : peek === null ? null : boardCardKey(peek);
  const targets: readonly TransferTarget[] =
    peekBoard === null
      ? []
      : boards
          .filter((board) => board.sessionId !== peekBoard.sessionId && !closedIn(board))
          .map((board) => ({
            sessionId: board.sessionId,
            label: board.label ?? board.plan.summary,
          }));

  return (
    <>
      <div className={className}>
        <KanbanBoard
          cards={cards}
          signalsOf={signalsOf}
          contextOf={contextOf}
          disabled={disabled}
          busy={request.isPending}
          onOpen={(item) => onPeek(refOf(item))}
          onReorder={(item, at) =>
            request.mutate(
              {
                sessionId: item.sessionId,
                action: KanbanAction.Intent({
                  intent: BoardIntent.Reorder({ cardId: item.card.id, at: at.card.id }),
                }),
              },
              { onError: refused },
            )
          }
          onSend={(item, sent, lands) => {
            setLanding({ key: item.key, lands });
            request.mutate(
              {
                sessionId: item.sessionId,
                action: KanbanAction.Intent({
                  intent: BoardIntent[sent]({ cardId: item.card.id }),
                }),
              },
              { onError: refused },
            );
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
      {peekState !== null && peekKey !== null && peekSession !== null && (
        <CardPeek
          key={peekKey}
          peek={peekState}
          entry={peeked}
          loopCard={peek === null ? null : loopCard(peek)}
          decisions={peek === null ? [] : decisionsOf(peek)}
          titleOf={titleIn(peekSession)}
          outcomeOf={outcomeIn(peekSession)}
          group={peekBoard?.label ?? null}
          changePending={peek !== null && changePending(peek)}
          projectId={projectId}
          holder={holder}
          disabled={disabled}
          closed={peekBoard === null || closedIn(peekBoard)}
          planVersion={peekBoard?.plan.version ?? 0}
          cardCount={peekBoard?.view.cards.length ?? 0}
          editPending={edit.isPending || action.isPending}
          intentPending={action.isPending || request.isPending}
          kanbanActive={peekBoard !== null && peekBoard.loop !== null}
          transferTargets={targets}
          onTransfer={(cardId, toSessionId) => {
            const item = itemOf({ sessionId: peekSession, cardId });
            const to = boardOf(toSessionId);
            if (item !== null && to !== null) setTransfer({ item, to });
          }}
          onEdit={(editing) => setEditingKey(editing && peek !== null ? boardCardKey(peek) : null)}
          onIntent={(sent, cardId) =>
            action.mutate(
              {
                sessionId: peekSession,
                action: KanbanAction.Intent({ intent: BoardIntent[sent]({ cardId }) }),
              },
              { onError: refused },
            )
          }
          onClose={() => {
            onAddingChange(null);
            setEditingKey(null);
            onPeek(null);
          }}
          onSubmit={(change) =>
            save(peekSession, change).catch((error: Error) => editErrorText(error))
          }
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
            <DialogTitle>{boardCopy.askChange.title}</DialogTitle>
            <DialogDescription>{boardCopy.askChange.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAskChange(null)}>
              {boardCopy.askChange.choices.keep}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (askChange !== null) {
                  setEditingKey(askChange.key);
                  onPeek(refOf(askChange));
                }
                setAskChange(null);
              }}
            >
              {boardCopy.askChange.choices.request}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={transfer !== null}
        onOpenChange={(next) => {
          if (!next) setTransfer(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{boardCopy.transfer.title}</DialogTitle>
            <DialogDescription>
              {transfer !== null &&
                boardCopy.transfer.body(
                  transfer.item.card.title,
                  transfer.to.label ?? transfer.to.plan.summary,
                )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTransfer(null)}>
              {boardCopy.transfer.choices.keep}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (transfer !== null) sendTransfer(transfer);
              }}
            >
              {boardCopy.transfer.choices.move}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
