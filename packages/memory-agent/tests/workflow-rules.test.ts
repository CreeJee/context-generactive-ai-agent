import { Effect, Layer } from "effect";
import { describe, expect, it, layer as testLayer } from "@effect/vitest";
import { Embedder, EmbeddingError } from "../src/memory/embedding/embedder.ts";
import { builtInWorkflowRules, WorkflowRules } from "../src/workflow/rules.ts";
import { fakeEmbedderLayer, fakeVector } from "../src/testing/fake-embedder.ts";

const layer = WorkflowRules.layer.pipe(Layer.provide(fakeEmbedderLayer));

describe("WorkflowRules", () => {
  testLayer(layer)((it) => {
    it.effect("always includes required phase rules and ranks relevant optional rules", () =>
      Effect.gen(function* () {
        const result = yield* (yield* WorkflowRules).resolve({
          phase: "plan",
          text: "Plan a database schema migration with a reversible backfill and tests",
          limit: 2,
        });
        expect(result.rules.map((rule) => rule.id)).toContain("workflow.plan.readonly");
        expect(result.rules.map((rule) => rule.id)).toContain("workflow.plan.actionable");
        expect(result.rules.map((rule) => rule.id)).toContain("workflow.plan.migration");
        expect(result.degraded).toEqual([]);
      }),
    );
  });

  it("has unique versioned ids", () => {
    const identities = builtInWorkflowRules.map((rule) => `${rule.id}@${rule.version}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it.effect("shares rule vectors across equivalent queries while embedding each query", () => {
    const calls: number[] = [];
    const countingEmbedder = Layer.succeed(Embedder, {
      identity: "counting-fake",
      dimensions: 64,
      embed: (texts) =>
        Effect.sync(() => {
          calls.push(texts.length);
          return texts.map(fakeVector);
        }),
      runtime: () => ({ kind: "other" }),
    });
    const countingLayer = WorkflowRules.layer.pipe(Layer.provide(countingEmbedder));

    return Effect.gen(function* () {
      const rules = yield* WorkflowRules;
      yield* rules.resolve({ phase: "plan", text: "database migration" });
      yield* rules.resolve({ phase: "plan", text: "schema backfill" });
      expect(calls).toEqual([expect.any(Number), 1, 1]);
    }).pipe(Effect.provide(countingLayer));
  });

  it.effect("retries rule vectors after a failed embedding", () => {
    let failRuleVectors = true;
    const recoveringEmbedder = Layer.succeed(Embedder, {
      identity: "recovering-fake",
      dimensions: 64,
      embed: (texts) =>
        Effect.gen(function* () {
          if (failRuleVectors && texts.length > 1) {
            failRuleVectors = false;
            return yield* new EmbeddingError({ cause: "temporary" });
          }
          return texts.map(fakeVector);
        }),
      runtime: () => ({ kind: "other" }),
    });
    const recoveringLayer = WorkflowRules.layer.pipe(Layer.provide(recoveringEmbedder));

    return Effect.gen(function* () {
      const rules = yield* WorkflowRules;
      const first = yield* rules.resolve({ phase: "plan", text: "database migration" });
      const second = yield* rules.resolve({ phase: "plan", text: "database migration" });
      expect(first.degraded).toEqual(["embedding"]);
      expect(second.degraded).toEqual([]);
    }).pipe(Effect.provide(recoveringLayer));
  });
});
