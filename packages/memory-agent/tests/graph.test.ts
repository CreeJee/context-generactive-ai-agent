import { MutableHashMap, Option, DateTime, Effect, FileSystem, Path } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Graph } from "../src/memory/graph.ts";
import { evidencePageLength, Nodes } from "../src/memory/nodes.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";
import { withTestPlatform } from "./support/platform.ts";

/** user -> assistant -> tool_call -> tool_result, then a later user correction. */
const conversation = Effect.fn("graph.conversation")(function* () {
  const context = yield* Effect.promise(() => testRuntime());
  const { runtime, project, session } = context;
  const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
  const at = { projectId: project.id, sessionId: session.id };

  const user = nodes.append({ ...at, kind: "user", text: "저장소는 SQLite로 하자" });
  const assistant = nodes.append({
    ...at,
    runId: "run-1",
    kind: "assistant",
    text: "스키마 파일을 확인할게요.",
    links: [{ kind: "reply", nodeId: user.id }],
  });
  const call = nodes.append({
    ...at,
    runId: "run-1",
    kind: "tool_call",
    text: 'read_file {"path":"schema.sql"}',
    links: [{ kind: "calls", nodeId: assistant.id }],
    refs: ["schema.sql"],
  });
  const result = nodes.append({
    ...at,
    runId: "run-1",
    kind: "tool_result",
    text: "CREATE TABLE nodes (...)",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  const correction = nodes.append({ ...at, kind: "user", text: "아니 Postgres로 바꾸자" });
  return { ...context, nodes, user, assistant, call, result, correction };
});

function addLlmEdge(
  db: Database["Service"],
  fromId: string,
  toId: string,
  kind: string,
  weight: number,
) {
  db.sqlite
    .prepare("INSERT INTO edges VALUES (?, ?, ?, 'llm', ?, ?)")
    .run(fromId, toId, kind, weight, DateTime.formatIso(DateTime.nowUnsafe()));
}

describe("Graph.traverse", () => {
  it.live(
    "empty nodes bridge evidence paths without filling search results or bypassing the budget",
    () =>
      Effect.gen(function* () {
        const { runtime, project, nodes, assistant, call, result, user } = yield* conversation();
        const empty = nodes.append({
          projectId: project.id,
          sessionId: assistant.sessionId,
          kind: "assistant",
          text: "\n ",
          links: [{ kind: "reply", nodeId: user.id }],
        });
        const { sqlite } = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
        sqlite
          .prepare("DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = 'calls'")
          .run(assistant.id, call.id);
        sqlite
          .prepare("INSERT INTO edges VALUES (?, ?, 'calls', 'structure', 0.95, ?)")
          .run(empty.id, call.id, empty.createdAt);
        const graph = yield* Effect.provideContext(Graph, yield* runtime.contextEffect);
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
      }).pipe(withTestPlatform),
  );

  it.live("expands from a seed with decaying utility and explains each path", () =>
    Effect.gen(function* () {
      const { runtime, project, user, assistant, call, result } = yield* conversation();
      const graph = yield* Effect.provideContext(Graph, yield* runtime.contextEffect);
      const { visits, complete } = graph.traverse(MutableHashMap.fromIterable([[result.id, 1]]), {
        budget: 10,
        minUtility: 0.5,
        projectIds: [project.id],
      });
      expect(complete).toBe(true);
      const byId = MutableHashMap.fromIterable(visits.map((visit) => [visit.node.id, visit]));
      expect(Option.getOrUndefined(MutableHashMap.get(byId, result.id))).toMatchObject({
        utility: 1,
        path: [],
      });
      expect(Option.getOrUndefined(MutableHashMap.get(byId, call.id))?.utility).toBeCloseTo(0.95);
      expect(Option.getOrUndefined(MutableHashMap.get(byId, assistant.id))?.utility).toBeCloseTo(
        0.95 * 0.95,
      );
      expect(Option.getOrUndefined(MutableHashMap.get(byId, user.id))?.utility).toBeCloseTo(
        0.95 * 0.95 * 0.9,
      );
      expect(Option.getOrUndefined(MutableHashMap.get(byId, user.id))?.path).toEqual([
        { nodeId: call.id, kind: "returns", direction: "in" },
        { nodeId: assistant.id, kind: "calls", direction: "in" },
        { nodeId: user.id, kind: "reply", direction: "out" },
      ]);
      // Visits come out strongest first.
      expect(visits.map((visit) => visit.utility)).toEqual(
        visits.map((visit) => visit.utility).toSorted((a, b) => b - a),
      );
    }).pipe(withTestPlatform),
  );

  it.live("reports an incomplete walk when the budget runs out", () =>
    Effect.gen(function* () {
      const { runtime, project, user } = yield* conversation();
      const graph = yield* Effect.provideContext(Graph, yield* runtime.contextEffect);
      const { visits, complete } = graph.traverse(MutableHashMap.fromIterable([[user.id, 1]]), {
        budget: 2,
        minUtility: 0.01,
        projectIds: [project.id],
      });
      expect(visits).toHaveLength(2);
      expect(complete).toBe(false);
    }).pipe(withTestPlatform),
  );

  it.live("never visits nodes of projects outside the allowed set", () =>
    Effect.gen(function* () {
      const { runtime, project, user, base } = yield* conversation();
      const other = yield* Effect.provideContext(
        Effect.gen(function* () {
          const root = (yield* Path.Path).join(base, "other");
          yield* (yield* FileSystem.FileSystem).makeDirectory(root);
          const otherProject = yield* (yield* Projects).add(root);
          const otherSession = yield* (yield* Sessions).create(otherProject.id);
          const nodes = yield* Nodes;
          return nodes.append({
            projectId: otherProject.id,
            sessionId: otherSession.id,
            kind: "user",
            text: "다른 프로젝트의 SQLite 이야기",
          });
        }),
        yield* runtime.contextEffect,
      );
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      addLlmEdge(db, other.id, user.id, "related", 0.9);
      const graph = yield* Effect.provideContext(Graph, yield* runtime.contextEffect);
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
    }).pipe(withTestPlatform),
  );
});

describe("Graph.trace", () => {
  it.live("follows a tool result back to the user turn and surfaces corrections", () =>
    Effect.gen(function* () {
      const { runtime, user, assistant, call, result, correction } = yield* conversation();
      const db = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      addLlmEdge(db, correction.id, user.id, "corrects", 0.95);
      const graph = yield* Effect.provideContext(Graph, yield* runtime.contextEffect);
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
    }).pipe(withTestPlatform),
  );
});

describe("Nodes.read", () => {
  it.live("pages original text without splitting surrogate pairs or touching CRLF", () =>
    Effect.gen(function* () {
      const { nodes, project, session } = yield* conversation();
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
    }).pipe(withTestPlatform),
  );
});
