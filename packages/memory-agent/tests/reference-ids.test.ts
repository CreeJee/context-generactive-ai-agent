import { expect, test } from "vite-plus/test";
import { MutableHashSet } from "effect";
import { referenceIds } from "../src/runtime/reference-ids.ts";

test("mutable and structurally identical SDK keys keep reference equality", () => {
  const id = referenceIds<{ state: number }>();
  const first = { state: 1 };
  const second = { state: 1 };
  const keys = MutableHashSet.make(id(first));
  first.state = 2;
  expect(MutableHashSet.has(keys, id(first))).toBe(true);
  expect(MutableHashSet.has(keys, id(second))).toBe(false);
});
