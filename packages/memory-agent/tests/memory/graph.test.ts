import { DateTime, Effect, FileSystem, MutableHashMap, Option, Path } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../../src/db/database.ts";
import { Graph } from "../../src/memory/graph.ts";
import { evidencePageLength, Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/** In a fresh session: user -> assistant -> tool_call -> tool_result, then a later user correction. */
const conversation = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const nodes = yield* Nodes;
  const at = { projectId: project.id, sessionId: session.id };
  const runId = `${session.id}:run`;

  const user = nodes.append({ ...at, kind: "user", text: "저장소는 SQLite로 하자" });
  const assistant = nodes.append({
    ...at,
    runId,
    kind: "assistant",
    text: "스키마 파일을 확인할게요.",
    links: [{ kind: "reply", nodeId: user.id }],
  });
  const call = nodes.append({
    ...at,
    runId,
    kind: "tool_call",
    text: 'read_file {"path":"schema.sql"}',
    links: [{ kind: "calls", nodeId: assistant.id }],
    refs: ["schema.sql"],
  });
  const result = nodes.append({
    ...at,
    runId,
    kind: "tool_result",
    text: "CREATE TABLE nodes (...)",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  const correction = nodes.append({ ...at, kind: "user", text: "아니 Postgres로 바꾸자" });
  return { project, session, nodes, user, assistant, call, result, correction };
});

const addLlmEdge = Effect.fnUntraced(function* (
  fromId: string,
  toId: string,
  kind: string,
  weight: number,
) {
  (yield* Database).sqlite
    .prepare("INSERT INTO edges VALUES (?, ?, ?, 'llm', ?, ?)")
    .run(fromId, toId, kind, weight, DateTime.formatIso(DateTime.nowUnsafe()));
});

/** A node in another project, which links to nothing yet. */
const otherProjectNode = Effect.fnUntraced(function* (name: string) {
  const { base } = yield* TestEnv;
  const root = (yield* Path.Path).join(base, `other-${name}`);
  yield* (yield* FileSystem.FileSystem).makeDirectory(root);
  const project = yield* (yield* Projects).add(root);
  const other = yield* (yield* Sessions).create(project.id);
  return (yield* Nodes).append({
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
        const empty = nodes.append({
          projectId: project.id,
          sessionId: assistant.sessionId,
          kind: "assistant",
          text: "\n ",
          links: [{ kind: "reply", nodeId: user.id }],
        });
        const { sqlite } = yield* Database;
        sqlite
          .prepare("DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = 'calls'")
          .run(assistant.id, call.id);
        sqlite
          .prepare("INSERT INTO edges VALUES (?, ?, 'calls', 'structure', 0.95, ?)")
          .run(empty.id, call.id, empty.createdAt);
        const graph = yield* Graph;
        const walk = graph.traverse(MutableHashMap.fromIterable([[result.id, 1]]), {
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
        const bounded = graph.traverse(MutableHashMap.fromIterable([[empty.id, 1]]), {
          budget: 1,
          minUtility: 0.1,
          projectIds: [project.id],
          includeEmpty: false,
        });
        expect(bounded).toEqual({ visits: [], complete: false });
        expect(graph.trace(result.id)?.chain.map((node) => node.id)).toEqual([
          result.id,
          call.id,
          empty.id,
          user.id,
        ]);
      }),
  );

  it.effect("expands from a seed with decaying utility and explains each path", () =>
    Effect.gen(function* () {
      const { project, user, assistant, call, result } = yield* conversation;
      const { visits, complete } = (yield* Graph).traverse(
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

  it.effect("reports an incomplete walk when the budget runs out", () =>
    Effect.gen(function* () {
      const { project, user } = yield* conversation;
      const { visits, complete } = (yield* Graph).traverse(
        MutableHashMap.fromIterable([[user.id, 1]]),
        { budget: 2, minUtility: 0.01, projectIds: [project.id] },
      );
      expect(visits).toHaveLength(2);
      expect(complete).toBe(false);
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
          .visits.map((visit) => visit.node.id);
      expect(walk([project.id])).not.toContain(other.id);
      expect(walk([project.id, other.projectId])).toContain(other.id);
    }),
  );

  it.effect("trace follows a tool result back to the user turn and surfaces corrections", () =>
    Effect.gen(function* () {
      const { user, assistant, call, result, correction } = yield* conversation;
      yield* addLlmEdge(correction.id, user.id, "corrects", 0.95);
      const graph = yield* Graph;
      const provenance = graph.trace(result.id);
      expect(provenance?.chain.map((node) => node.id)).toEqual([
        result.id,
        call.id,
        assistant.id,
        user.id,
      ]);
      expect(provenance?.challengedBy).toEqual([
        { node: expect.objectContaining({ id: correction.id }), kind: "corrects", target: user.id },
      ]);
      expect(graph.trace("missing")).toBeNull();
    }),
  );

  it.effect(
    "Nodes.read pages original text without splitting surrogate pairs or touching CRLF",
    () =>
      Effect.gen(function* () {
        const { nodes, project, session } = yield* conversation;
        const text = `${"a".repeat(evidencePageLength - 1)}😀\r\n끝`;
        const node = nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "tool_result",
          text,
        });
        const first = nodes.read(node.id);
        expect(first).toMatchObject({
          offset: 0,
          nextOffset: evidencePageLength - 1,
          length: text.length,
        });
        const second = nodes.read(node.id, first!.nextOffset!);
        expect(second).toMatchObject({ text: "😀\r\n끝", nextOffset: null });
        expect(first!.text + second!.text).toBe(text);
        expect(nodes.read("missing")).toBeNull();
      }),
  );
});
