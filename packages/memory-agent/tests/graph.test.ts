import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Graph } from "../src/memory/graph.ts";
import { evidencePageLength, Nodes } from "../src/memory/nodes.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";

/** user -> assistant -> tool_call -> tool_result, then a later user correction. */
async function conversation() {
  const context = await testRuntime();
  const { runtime, project, session } = context;
  const nodes = await runtime.runPromise(Nodes);
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
}

function addLlmEdge(
  db: Database["Type"],
  fromId: string,
  toId: string,
  kind: string,
  weight: number,
) {
  db.sqlite
    .prepare("INSERT INTO edges VALUES (?, ?, ?, 'llm', ?, ?)")
    .run(fromId, toId, kind, weight, new Date().toISOString());
}

describe("Graph.traverse", () => {
  test("expands from a seed with decaying utility and explains each path", async () => {
    const { runtime, project, user, assistant, call, result } = await conversation();
    const graph = await runtime.runPromise(Graph);

    const { visits, complete } = graph.traverse(new Map([[result.id, 1]]), {
      budget: 10,
      minUtility: 0.5,
      projectIds: [project.id],
    });

    expect(complete).toBe(true);
    const byId = new Map(visits.map((visit) => [visit.node.id, visit]));
    expect(byId.get(result.id)).toMatchObject({ utility: 1, path: [] });
    expect(byId.get(call.id)?.utility).toBeCloseTo(0.95);
    expect(byId.get(assistant.id)?.utility).toBeCloseTo(0.95 * 0.95);
    expect(byId.get(user.id)?.utility).toBeCloseTo(0.95 * 0.95 * 0.9);
    expect(byId.get(user.id)?.path).toEqual([
      { nodeId: call.id, kind: "returns", direction: "in" },
      { nodeId: assistant.id, kind: "calls", direction: "in" },
      { nodeId: user.id, kind: "reply", direction: "out" },
    ]);
    // Visits come out strongest first.
    expect(visits.map((visit) => visit.utility)).toEqual(
      visits.map((visit) => visit.utility).toSorted((a, b) => b - a),
    );
  });

  test("reports an incomplete walk when the budget runs out", async () => {
    const { runtime, project, user } = await conversation();
    const graph = await runtime.runPromise(Graph);
    const { visits, complete } = graph.traverse(new Map([[user.id, 1]]), {
      budget: 2,
      minUtility: 0.01,
      projectIds: [project.id],
    });
    expect(visits).toHaveLength(2);
    expect(complete).toBe(false);
  });

  test("never visits nodes of projects outside the allowed set", async () => {
    const { runtime, project, user, base } = await conversation();
    const other = await runtime.runPromise(
      Effect.gen(function* () {
        const root = join(base, "other");
        mkdirSync(root);
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
    );
    const db = await runtime.runPromise(Database);
    addLlmEdge(db, other.id, user.id, "related", 0.9);
    const graph = await runtime.runPromise(Graph);

    const walk = (projectIds: string[]) =>
      graph
        .traverse(new Map([[user.id, 1]]), { budget: 20, minUtility: 0.1, projectIds })
        .visits.map((visit) => visit.node.id);
    expect(walk([project.id])).not.toContain(other.id);
    expect(walk([project.id, other.projectId])).toContain(other.id);
  });
});

describe("Graph.trace", () => {
  test("follows a tool result back to the user turn and surfaces corrections", async () => {
    const { runtime, user, assistant, call, result, correction } = await conversation();
    const db = await runtime.runPromise(Database);
    addLlmEdge(db, correction.id, user.id, "corrects", 0.95);
    const graph = await runtime.runPromise(Graph);

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
  });
});

describe("Nodes.read", () => {
  test("pages original text without splitting surrogate pairs or touching CRLF", async () => {
    const { nodes, project, session } = await conversation();
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
  });
});
