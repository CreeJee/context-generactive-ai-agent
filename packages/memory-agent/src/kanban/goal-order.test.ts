import { describe, expect, test } from "vite-plus/test";
import { moved } from "./goal-order.ts";

describe("priority tree order", () => {
  test("puts the item in front of `before`, or last, and ignores unknown names", () => {
    const order = ["a", "b", "c"];
    expect(moved(order, "c", "a")).toEqual(["c", "a", "b"]);
    expect(moved(order, "a", "c")).toEqual(["b", "a", "c"]);
    expect(moved(order, "a", null)).toEqual(["b", "c", "a"]);
    expect(moved(order, "b", "b")).toBe(order);
    expect(moved(order, "x", "a")).toBe(order);
    expect(moved(order, "a", "x")).toBe(order);
  });
});
