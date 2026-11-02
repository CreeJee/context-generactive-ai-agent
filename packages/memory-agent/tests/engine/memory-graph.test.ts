import { Effect, MutableHashMap, Option } from "effect";
import { expect } from "vite-plus/test";
import { Graph } from "../../src/memory/graph.ts";
import { conversation } from "../support/memory-graph.ts";
import { testAgent } from "../support/test-env.ts";

testAgent()("memory graph", (it) => {
  it.effect("expands from a seed with decaying utility and explains each path", () =>
    Effect.gen(function* () {
      const { project, user, assistant, call, result } = yield* conversation;
      const { visits, complete } = yield* (yield* Graph).traverse(
        MutableHashMap.fromIterable([[result.id, 1]]),
        { budget: 10, minUtility: 0.5, projectIds: [project.id] },
      );
      expect(complete).toBe(true);
      const byId = MutableHashMap.fromIterable(visits.map((visit) => [visit.node.id, visit]));
      const visit = (id: string) => Option.getOrUndefined(MutableHashMap.get(byId, id));
      expect(visit(result.id)).toMatchObject({ utility: 1, path: [] });
      expect(visit(call.id)?.utility).toBeCloseTo(0.95);
      expect(visit(assistant.id)?.utility).toBeCloseTo(0.95 * 0.95);
      expect(visit(user.id)?.utility).toBeCloseTo(0.95 * 0.95 * 0.9);
      expect(visit(user.id)?.path).toEqual([
        { nodeId: call.id, kind: "returns", direction: "in" },
        { nodeId: assistant.id, kind: "calls", direction: "in" },
        { nodeId: user.id, kind: "reply", direction: "out" },
      ]);
      // Visits come out strongest first.
      expect(visits.map((visit) => visit.utility)).toEqual(
        visits.map((visit) => visit.utility).toSorted((a, b) => b - a),
      );
    }),
  );
});
