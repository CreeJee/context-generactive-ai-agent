import { BoardAuthor } from "memory-agent";
import { describe, expect, test } from "vite-plus/test";
import type { BoardView } from "../../api";
import {
  DropOutcome,
  dropOutcome,
  PendingMove,
  withPending,
  type DropContext,
} from "./board-moves";

type BoardCard = BoardView["cards"][number];

const step = (
  id: string,
  status: BoardCard["card"]["status"],
  dependsOn: readonly string[] = [],
): BoardCard => ({
  card: {
    id,
    title: `Card ${id}`,
    description: "",
    dependsOn: [...dependsOn],
    acceptanceCriteria: [],
    ruleRefs: [],
    status,
    evidence: [],
  },
  lastChange: null,
});

const held = (entry: BoardCard): BoardCard => ({
  ...entry,
  card: {
    ...entry.card,
    hold: { by: BoardAuthor.cases.User.make({}), at: "2026-10-18T00:00:00Z" },
  },
});
const cards = [
  step("a", "in_progress"),
  step("b", "backlog", ["a"]),
  held(step("c", "backlog", ["gone"])),
  step("d", "blocked"),
  step("e", "ready"),
];
const context: DropContext = {
  cards: cards.map(({ card }) => card),
  kanbanActive: true,
  closed: false,
};
const card = (id: string) => cards.find((entry) => entry.card.id === id)!.card;

describe("board drops", () => {
  test("a drop on another column means hold, release or requeue", () => {
    expect(dropOutcome(card("e"), "backlog", context)).toEqual(
      DropOutcome.Send({ intent: "Hold", lands: "backlog" }),
    );
    // A dependency no longer on the board does not hold the card back, as on the server.
    expect(dropOutcome(card("c"), "ready", context)).toEqual(
      DropOutcome.Send({ intent: "Release", lands: "ready" }),
    );
    expect(dropOutcome(card("d"), "ready", context)).toEqual(
      DropOutcome.Send({ intent: "Requeue", lands: "ready" }),
    );
  });

  test("a card waiting for its dependencies cannot be pushed to ready", () => {
    expect(dropOutcome(card("b"), "ready", context)).toEqual(
      DropOutcome.Refused({ reason: "의존 카드가 아직 끝나지 않았어요." }),
    );
  });

  test("an executing card asks for a change request instead of moving", () => {
    expect(dropOutcome(card("a"), "done", context)).toEqual(DropOutcome.AskChange());
    expect(dropOutcome(card("a"), "in_progress", context)).toEqual(DropOutcome.Reorder());
  });

  test("holding and requeueing need the kanban loop", () => {
    expect(
      DropOutcome.$is("Refused")(
        dropOutcome(card("d"), "ready", { ...context, kanbanActive: false }),
      ),
    ).toBe(true);
  });
});

describe("pending board moves", () => {
  test("shows a move while it is saved, and the server's board once it is refused", () => {
    const moved = withPending(cards, PendingMove.Status({ cardId: "d", to: "ready" }));
    expect(moved.find((entry) => entry.card.id === "d")?.card.status).toBe("ready");
    const reordered = withPending(cards, PendingMove.Order({ cardId: "d", index: 0 }));
    expect(reordered.map((entry) => entry.card.id)).toEqual(["d", "a", "b", "c", "e"]);
    // A refused mutation is no longer pending: the board is the server's again.
    expect(withPending(cards, null)).toBe(cards);
  });
});
