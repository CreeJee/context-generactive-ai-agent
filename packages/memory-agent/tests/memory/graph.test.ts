import { DateTime, Effect, MutableHashMap } from "effect";
import { expect } from "vite-plus/test";
import { Graph } from "../../src/memory/graph.ts";
import { evidencePageLength } from "../../src/memory/nodes.ts";
import { conversation } from "../support/memory-graph.ts";
import { testAgent } from "../support/test-env.ts";
import { sqlRun } from "../support/sql.ts";

const addLlmEdge = Effect.fnUntraced(function* (
  fromId: string,
  toId: string,
  kind: string,
  weight: number,
) {
  yield* sqlRun(
    "INSERT INTO edges VALUES (?, ?, ?, 'llm', ?, ?)",
    fromId,
    toId,
    kind,
    weight,
    DateTime.formatIso(DateTime.nowUnsafe()),
  );
});

testAgent()("memory graph", (it) => {
  it.effect(
    "empty nodes bridge evidence paths without filling search results or bypassing the budget",
    () =>
      Effect.gen(function* () {
        const { project, nodes, assistant, call, result, user } = yield* conversation;
        const empty = yield* nodes.append({
          projectId: project.id,
          sessionId: assistant.sessionId,
          kind: "assistant",
          text: "\n ",
          links: [{ kind: "reply", nodeId: user.id }],
        });
        yield* sqlRun(
          "DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = 'calls'",
          assistant.id,
          call.id,
        );
        yield* sqlRun(
          "INSERT INTO edges VALUES (?, ?, 'calls', 'structure', 0.95, ?)",
          empty.id,
          call.id,
          empty.createdAt,
        );
        const graph = yield* Graph;
        const walk = yield* graph.traverse(MutableHashMap.fromIterable([[result.id, 1]]), {
          budget: 20,
          minUtility: 0.1,
          projectIds: [project.id],
          includeEmpty: false,
        });
        expect(walk.visits.some((visit) => visit.node.id === empty.id)).toBe(false);
        expect(walk.visits.find((visit) => visit.node.id === user.id)?.path).toContainEqual({
          nodeId: empty.id,
          kind: "calls",
          direction: "in",
        });
        const bounded = yield* graph.traverse(MutableHashMap.fromIterable([[empty.id, 1]]), {
          budget: 1,
          minUtility: 0.1,
          projectIds: [project.id],
          includeEmpty: false,
        });
        expect(bounded).toEqual({ visits: [], complete: false });
        expect((yield* graph.trace(result.id))?.chain.map((node) => node.id)).toEqual([
          result.id,
          call.id,
          empty.id,
          user.id,
        ]);
      }),
  );

  it.effect("trace follows a tool result back to the user turn and surfaces corrections", () =>
    Effect.gen(function* () {
      const { user, assistant, call, result, correction } = yield* conversation;
      yield* addLlmEdge(correction.id, user.id, "corrects", 0.95);
      const graph = yield* Graph;
      const provenance = yield* graph.trace(result.id);
      expect(provenance?.chain.map((node) => node.id)).toEqual([
        result.id,
        call.id,
        assistant.id,
        user.id,
      ]);
      expect(provenance?.challengedBy).toEqual([
        { node: expect.objectContaining({ id: correction.id }), kind: "corrects", target: user.id },
      ]);
      expect(yield* graph.trace("missing")).toBeNull();
    }),
  );

  it.effect(
    "evidence pages split original text without breaking surrogate pairs or touching CRLF",
    () =>
      Effect.gen(function* () {
        const { nodes, project, session } = yield* conversation;
        const text = `${"a".repeat(evidencePageLength - 1)}😀\r\n끝`;
        const node = yield* nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "tool_result",
          text,
        });
        const first = yield* nodes.page(node);
        expect(first).toMatchObject({
          offset: 0,
          nextOffset: evidencePageLength - 1,
          length: text.length,
        });
        const second = yield* nodes.page(node, first.nextOffset!);
        expect(second).toMatchObject({ text: "😀\r\n끝", nextOffset: null });
        expect(first.text + second.text).toBe(text);
      }),
  );
});
