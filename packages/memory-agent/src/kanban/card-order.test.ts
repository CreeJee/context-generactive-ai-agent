import { describe, expect, test } from "vite-plus/test";
import {
  mergeByRank,
  placed,
  projection,
  type OrderedCard,
  type OrderedPlan,
} from "./card-order.ts";

const plan = (
  sessionId: string,
  priority: OrderedPlan["priority"],
  cards: ReadonlyArray<readonly [string, number | null]>,
): OrderedPlan => ({
  sessionId,
  priority,
  cards: cards.map(([cardId, rank]) => ({ cardId, rank })),
});
const keys = (order: readonly OrderedCard[]) =>
  order.map((card) => `${card.sessionId}:${card.cardId}`);
const ref = (sessionId: string, cardId: string): OrderedCard => ({ sessionId, cardId });

describe("project card order", () => {
  test("ranks interleave Plans; a new card follows its predecessor; fresh Plans go last by priority", () => {
    const order = mergeByRank([
      plan("a", "normal", [
        ["a1", 0],
        ["a2", 3],
        ["a3", null],
      ]),
      plan("b", "normal", [
        ["b1", 1],
        ["b2", 2],
      ]),
      plan("c", "low", [["c1", null]]),
      plan("d", "high", [
        ["d1", null],
        ["d2", null],
      ]),
    ]);
    expect(keys(order)).toEqual(["a:a1", "b:b1", "b:b2", "a:a2", "a:a3", "d:d1", "d:d2", "c:c1"]);
  });

  test("a Plan's own order holds even where its cards' ranks disagree", () => {
    const order = mergeByRank([
      plan("a", "normal", [
        ["a2", 5],
        ["a1", 0],
      ]),
      plan("b", "normal", [["b1", 3]]),
    ]);
    expect(keys(order)).toEqual(["b:b1", "a:a2", "a:a1"]);
  });

  test("a placed card takes the place of the card it was dropped on, in any Plan", () => {
    const order = mergeByRank([
      plan("a", "normal", [
        ["a1", 0],
        ["a2", 1],
      ]),
      plan("b", "normal", [["b1", 2]]),
    ]);
    const across = placed(order, ref("b", "b1"), ref("a", "a2"));
    expect(keys(across)).toEqual(["a:a1", "b:b1", "a:a2"]);
    expect(projection(across, "a")).toEqual(["a1", "a2"]);
    // Dropping a card onto a later one puts it after that one, as the board shows while dragging.
    const down = placed(across, ref("a", "a1"), ref("a", "a2"));
    expect(keys(down)).toEqual(["b:b1", "a:a2", "a:a1"]);
    expect(projection(down, "a")).toEqual(["a2", "a1"]);
    expect(keys(placed(down, ref("b", "b1"), null))).toEqual(["a:a2", "a:a1", "b:b1"]);
    // A card or target that is not on the board changes nothing.
    expect(placed(down, ref("a", "gone"), null)).toBe(down);
    expect(placed(down, ref("a", "a1"), ref("b", "gone"))).toBe(down);
  });
});
