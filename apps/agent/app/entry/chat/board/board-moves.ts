import { Data, Function as EffectFunction } from "effect";
import type { BoardView, CardStatus } from "../../api";

export type BoardCard = BoardView["cards"][number];
type PlanStep = BoardCard["card"];

/** A card named by its conversation and card id: the `boardCard` query and the board's keys. */
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

/**
 * A card as a board page shows it: with its conversation, and a key unique across the
 * conversations one board may show. Card ids repeat between Plans; keys do not.
 */
export interface BoardItem extends BoardCard {
  readonly key: string;
  readonly sessionId: string;
}
export const boardItem: {
  (entry: BoardCard): (sessionId: string) => BoardItem;
  (sessionId: string, entry: BoardCard): BoardItem;
} = EffectFunction.dual(2, (sessionId: string, entry: BoardCard): BoardItem => ({
  ...entry,
  sessionId,
  key: boardCardKey({ sessionId, cardId: entry.card.id }),
}));

export const cardStatusLabels: Readonly<Record<CardStatus, string>> = {
  backlog: "백로그",
  ready: "준비",
  in_progress: "진행 중",
  verify: "검증",
  human_decision: "판단 필요",
  done: "완료",
  blocked: "막힘",
};

/** Board columns, left to right. */
export const boardColumns: readonly CardStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "verify",
  "human_decision",
  "done",
  "blocked",
];

/** What dropping a card on a column means. The server decides the card's status from it. */
export type DropOutcome = Data.TaggedEnum<{
  /**
   * Same column: the card takes the place of the card it was dropped on in the project's order,
   * which may be a card of another conversation.
   */
  Reorder: {};
  /**
   * Another column the person can ask for: hold, release or requeue. `lands` is where the card is
   * expected to go, shown as a request until the server's board arrives.
   */
  Send: { readonly intent: "Hold" | "Release" | "Requeue"; readonly lands: CardStatus };
  /** An executing card is the orchestrator's; the person may leave a change request instead. */
  AskChange: {};
  Refused: { readonly reason: string };
}>;
export const DropOutcome = Data.taggedEnum<DropOutcome>();

export interface DropContext {
  /** The Plan's cards in Plan order, as the board shows them. */
  readonly cards: readonly PlanStep[];
  /** Holding and requeueing need the kanban loop that assigns cards. */
  readonly kanbanActive: boolean;
  readonly closed: boolean;
}

const refused = (reason: string): DropOutcome => DropOutcome.Refused({ reason });

/** Whether the card's known dependencies are all done; unknown ids do not hold it back. */
const dependenciesDone = (cards: readonly PlanStep[], card: PlanStep) => {
  const ids = new Set(cards.map((other) => other.id));
  const done = new Set(cards.filter((other) => other.status === "done").map((other) => other.id));
  return card.dependsOn.filter((id) => id !== card.id && ids.has(id)).every((id) => done.has(id));
};

/** Why a column takes no drop: the orchestrator moves cards there. */
const orchestratorColumn = (to: CardStatus) => {
  switch (to) {
    case "in_progress":
    case "verify":
    case "done":
      return `${cardStatusLabels[to]} 열은 오케스트레이터가 옮겨요.`;
    case "human_decision":
      return "판단 요청은 오케스트레이터가 만들어요.";
    case "blocked":
      return "막힘은 오케스트레이터가 표시해요.";
    case "backlog":
      return "준비 카드만 백로그로 보류할 수 있어요.";
    case "ready":
      return "보류했거나 막힌 카드만 준비로 옮길 수 있어요.";
  }
};

const send = (
  intent: "Hold" | "Release" | "Requeue",
  lands: CardStatus,
  context: DropContext,
): DropOutcome =>
  context.kanbanActive
    ? DropOutcome.Send({ intent, lands })
    : refused("칸반으로 실행할 때만 보류하거나 다시 대기열에 넣을 수 있어요.");

/**
 * What dropping `card` on the `to` column means: ready to backlog holds it, a held card back to
 * ready releases it, blocked to ready requeues it. A refused drop says why before the server is
 * asked; the server still checks the intent against the card.
 */
function dropOutcomeBody(card: PlanStep, to: CardStatus, context: DropContext): DropOutcome {
  if (context.closed) return refused("완료된 계획은 바꿀 수 없어요.");
  if (card.status === to) return DropOutcome.Reorder();
  switch (card.status) {
    case "in_progress":
      return DropOutcome.AskChange();
    case "human_decision":
      return refused("판단 필요 카드는 판단에 답하면 옮겨져요.");
    case "verify":
      return refused("검증 중인 카드는 오케스트레이터가 옮겨요.");
    case "done":
      return refused("완료된 카드는 옮길 수 없어요.");
    case "ready":
      return to === "backlog" ? send("Hold", "backlog", context) : refused(orchestratorColumn(to));
    case "backlog":
      if (to !== "ready") return refused(orchestratorColumn(to));
      if (card.hold === undefined) return refused("의존 카드가 아직 끝나지 않았어요.");
      return send("Release", dependenciesDone(context.cards, card) ? "ready" : "backlog", context);
    case "blocked":
      return to === "ready"
        ? send("Requeue", "ready", context)
        : refused("막힌 카드는 준비 열로만 옮길 수 있어요.");
  }
}

export const dropOutcome: {
  (to: CardStatus, context: DropContext): (card: PlanStep) => DropOutcome;
} & typeof dropOutcomeBody = EffectFunction.dual(3, dropOutcomeBody);

/**
 * The shown cards in the project's order: by the rank the server gives each card, which is where
 * the scheduler starts it, and cards without one after them as the boards list them. One board
 * without ranks stays in Plan order.
 */
export const inProjectOrder = (
  entries: ReadonlyArray<{ readonly item: BoardItem; readonly rank: number | null }>,
): readonly BoardItem[] =>
  entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank || a.index - b.index;
      if (a.rank === null && b.rank === null) return a.index - b.index;
      return a.rank === null ? 1 : -1;
    })
    .map(({ item }) => item);

/** Which card statuses can leave their Plan for another conversation's Plan. */
const transferable: Readonly<Record<CardStatus, boolean>> = {
  backlog: true,
  ready: true,
  blocked: true,
  in_progress: false,
  verify: false,
  human_decision: false,
  done: false,
};
export const canTransfer = (card: PlanStep) => transferable[card.status];

/**
 * A request sent to the server and not answered yet. The board shows the card where it is expected
 * to land, marked as requested; the server's board then draws it where it really is.
 */
export type PendingMove = Data.TaggedEnum<{
  Status: { readonly key: string; readonly to: CardStatus };
  /** `index` is the card's new place among the shown cards. */
  Order: { readonly key: string; readonly index: number };
  /** The card is leaving for another conversation's Plan; it stays where it is until it has. */
  Leaving: { readonly key: string };
}>;
export const PendingMove = Data.taggedEnum<PendingMove>();

/**
 * The cards the board shows: the server's, with the pending request applied. A refused request is
 * no longer pending, so the card goes back to where the server has it.
 */
function withPendingBody(
  items: readonly BoardItem[],
  pending: PendingMove | null,
): readonly BoardItem[] {
  if (pending === null) return items;
  return PendingMove.$match(pending, {
    Status: ({ key, to }) =>
      items.map((item) =>
        item.key === key ? { ...item, card: { ...item.card, status: to } } : item,
      ),
    Order: ({ key, index }) => {
      const from = items.findIndex((item) => item.key === key);
      if (from < 0) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      if (moved !== undefined) next.splice(Math.min(index, next.length), 0, moved);
      return next;
    },
    Leaving: () => items,
  });
}
export const withPending: {
  (pending: PendingMove | null): (items: readonly BoardItem[]) => readonly BoardItem[];
} & typeof withPendingBody = EffectFunction.dual(2, withPendingBody);
