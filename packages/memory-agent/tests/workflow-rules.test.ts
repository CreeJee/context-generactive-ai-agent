import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { builtInWorkflowRules, WorkflowRules } from "../src/workflow/rules.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";

const layer = WorkflowRules.layer.pipe(Layer.provide(fakeEmbedderLayer));

describe("WorkflowRules", () => {
  test("always includes required phase rules and ranks relevant optional rules", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WorkflowRules).resolve({
          phase: "plan",
          text: "Plan a database schema migration with a reversible backfill and tests",
          limit: 2,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.rules.map((rule) => rule.id)).toContain("workflow.plan.readonly");
    expect(result.rules.map((rule) => rule.id)).toContain("workflow.plan.actionable");
    expect(result.rules.map((rule) => rule.id)).toContain("workflow.plan.migration");
    expect(result.degraded).toEqual([]);
  });

  test("has unique versioned ids", () => {
    const identities = builtInWorkflowRules.map((rule) => `${rule.id}@${rule.version}`);
    expect(new Set(identities).size).toBe(identities.length);
  });
});
