import { DateTime, Effect, FileSystem, MutableHashMap, Path } from "effect";
import { expect } from "vite-plus/test";
import { Graph } from "../../src/memory/graph.ts";
import { evidencePageLength, Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { conversation } from "../support/memory-graph.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
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

/** A node in another project, which links to nothing yet. */
const otherProjectNode = Effect.fnUntraced(function* (name: string) {
  const { base } = yield* TestEnv;
  const root = (yield* Path.Path).join(base, `other-${name}`);
  yield* (yield* FileSystem.FileSystem).makeDirectory(root);
  const project = yield* (yield* Projects).add(root);
  const other = yield* (yield* Sessions).create(project.id);
  return yield* (yield* Nodes).append({
    projectId: project.id,
    sessionId: other.id,
    kind: "user",
    text: "다른 프로젝트의 SQLite 이야기",
  });
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

  it.effect("never visits nodes of projects outside the allowed set", () =>
    Effect.gen(function* () {
      const { project, session, user } = yield* conversation;
      const other = yield* otherProjectNode(session.id);
      yield* addLlmEdge(other.id, user.id, "related", 0.9);
      const graph = yield* Graph;
      const walk = (projectIds: string[]) =>
        graph
          .traverse(MutableHashMap.fromIterable([[user.id, 1]]), {
            budget: 20,
            minUtility: 0.1,
            projectIds,
          })
          .pipe(Effect.map(({ visits }) => visits.map((visit) => visit.node.id)));
      expect(yield* walk([project.id])).not.toContain(other.id);
      expect(yield* walk([project.id, other.projectId])).toContain(other.id);
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
    "Nodes.read pages original text without splitting surrogate pairs or touching CRLF",
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
        const first = yield* nodes.read(node.id);
        expect(first).toMatchObject({
          offset: 0,
          nextOffset: evidencePageLength - 1,
          length: text.length,
        });
        const second = yield* nodes.read(node.id, first!.nextOffset!);
        expect(second).toMatchObject({ text: "😀\r\n끝", nextOffset: null });
        expect(first!.text + second!.text).toBe(text);
        expect(yield* nodes.read("missing")).toBeNull();
      }),
  );
});
