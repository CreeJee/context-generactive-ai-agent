import { Array as EffectArray } from "effect";
import { Effect, Layer, MutableRef } from "effect";
import { describe, expect, it, layer as testLayer } from "@effect/vitest";
import { EmbedderRuntime, Embedder, EmbeddingError } from "../memory/embedding/embedder.ts";
import { builtInWorkflowRules, WorkflowRules } from "./rules.ts";
import { fakeEmbedderLayer, fakeVector } from "../testing/fake-embedder.ts";

const layer = WorkflowRules.layer.pipe(Layer.provide(fakeEmbedderLayer));

describe("WorkflowRules", () => {
  testLayer(layer)((it) => {
    it.effect("always includes required phase rules and ranks relevant optional rules", () =>
      Effect.gen(function* () {
        const result = yield* (yield* WorkflowRules).resolve({
          phases: ["plan"],
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
    expect(EffectArray.dedupe(identities).length).toBe(identities.length);
  });

  const calls: number[] = [];
  const countingEmbedder = Layer.succeed(Embedder, {
    identity: "counting-fake",
    dimensions: 64,
    embed: (texts) =>
      Effect.sync(() => {
        calls.push(texts.length);
        return texts.map(fakeVector);
      }),
    runtime: () => EmbedderRuntime.other(),
  });
  testLayer(WorkflowRules.layer.pipe(Layer.provide(countingEmbedder)))((it) => {
    it.effect("shares rule vectors across equivalent queries while embedding each query", () =>
      Effect.gen(function* () {
        const rules = yield* WorkflowRules;
        yield* rules.resolve({ phases: ["plan"], text: "database migration" });
        yield* rules.resolve({ phases: ["plan"], text: "schema backfill" });
        expect(calls).toEqual([expect.any(Number), 1, 1]);
        // A project's own rule is embedded alone; the built-in rules beside it are not again.
        const builtIn = builtInWorkflowRules.find((rule) => rule.id === "workflow.plan.migration")!;
        yield* rules.resolve({
          phases: ["plan"],
          text: "schema backfill",
          rules: [{ ...builtIn, id: "project.plan.fixtures", instruction: "Seed fixtures first." }],
        });
        expect(calls.slice(3)).toEqual([1, 1]);
      }),
    );
  });

  const prepared: (readonly string[])[] = [];
  const recordingEmbedder = Layer.succeed(Embedder, {
    identity: "recording-fake",
    dimensions: 64,
    embed: (texts) =>
      Effect.sync(() => {
        prepared.push(texts);
        return texts.map(fakeVector);
      }),
    runtime: () => EmbedderRuntime.other(),
  });
  testLayer(WorkflowRules.layer.pipe(Layer.provide(recordingEmbedder)))((it) => {
    it.effect("after prepare, a Goal's turn embeds only its question", () =>
      Effect.gen(function* () {
        const rules = yield* WorkflowRules;
        yield* rules.prepare;
        yield* rules.resolve({ phases: ["goal", "plan"], text: "database migration" });
        yield* rules.resolve({ phases: ["verify"], text: "acceptance tests" });
        expect(prepared.slice(1)).toEqual([["database migration"], ["acceptance tests"]]);
      }),
    );
  });

  const failRuleVectors = MutableRef.make(true);
  const recoveringEmbedder = Layer.succeed(Embedder, {
    identity: "recovering-fake",
    dimensions: 64,
    embed: (texts) =>
      Effect.gen(function* () {
        // Only the first batch of rule vectors fails.
        if (texts.length > 1 && MutableRef.getAndSet(failRuleVectors, false)) {
          return yield* EmbeddingError.make({ cause: "temporary" });
        }
        return texts.map(fakeVector);
      }),
    runtime: () => EmbedderRuntime.other(),
  });
  testLayer(WorkflowRules.layer.pipe(Layer.provide(recoveringEmbedder)))((it) => {
    it.effect("retries rule vectors after a failed embedding", () =>
      Effect.gen(function* () {
        const rules = yield* WorkflowRules;
        const first = yield* rules.resolve({ phases: ["plan"], text: "database migration" });
        const second = yield* rules.resolve({ phases: ["plan"], text: "database migration" });
        expect(first.degraded).toEqual(["embedding"]);
        expect(second.degraded).toEqual([]);
      }),
    );
  });
});
