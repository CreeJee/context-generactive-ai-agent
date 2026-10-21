import { Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { OwnerCommand } from "./worker-protocol.ts";

it("admits a bounded budget without exposing a shared backing-store control", () => {
  const request = OwnerCommand.cases["vector-search-controlled"].make({
    epoch: "schema",
    requestId: "one",
    query: new Float32Array(8),
    k: 1,
    allowedIds: [],
    budgetMs: 2_000,
  });
  const valid = Schema.is(OwnerCommand);
  expect(valid(request)).toBe(true);
  expect(valid({ ...request, controlToken: 42 })).toBe(false);
  expect(valid({ ...request, budgetMs: Number.NaN })).toBe(false);
  expect(valid({ ...request, budgetMs: -1 })).toBe(false);
  expect(valid({ ...request, budgetMs: 2_001 })).toBe(false);
});
