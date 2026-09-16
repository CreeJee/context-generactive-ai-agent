import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chat } from "@tanstack/ai";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Embedder, EmbeddingError } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Recorder } from "../src/memory/record.ts";
import { fuseRanks, MemorySearch, searchTerms } from "../src/memory/search.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { MemoryTools } from "../src/tools/memory.ts";
import { testRuntime } from "./support/runtime.ts";

type Runtime = Awaited<ReturnType<typeof testRuntime>>["runtime"];

/** An earlier session: a decision, then the assistant reads a file about it. */
async function earlierSession(runtime: Runtime, projectId: string, sessionId: string) {
  const nodes = await runtime.runPromise(Nodes);
  const at = { projectId, sessionId };
  const decision = nodes.append({
    ...at,
    kind: "user",
    text: "저장소는 SQLite로 결정했다. Postgres는 과하다.",
  });
  const answer = nodes.append({
    ...at,
    runId: "old-run",
    kind: "assistant",
    text: "스키마를 확인할게요.",
    links: [{ kind: "reply", nodeId: decision.id }],
  });
  const call = nodes.append({
    ...at,
    runId: "old-run",
    kind: "tool_call",
    text: 'read_file {"path":"schema.sql"}',
    links: [{ kind: "calls", nodeId: answer.id }],
    refs: ["schema.sql"],
  });
  const result = nodes.append({
    ...at,
    runId: "old-run",
    kind: "tool_result",
    text: "CREATE TABLE nodes (seq INTEGER PRIMARY KEY)",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  return { decision, answer, call, result };
}

async function otherProject(runtime: Runtime, base: string, text: string) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const root = join(base, `other-${Math.random().toString(36).slice(2)}`);
      mkdirSync(root);
      const project = yield* (yield* Projects).add(root);
      const session = yield* (yield* Sessions).create(project.id);
      const node = (yield* Nodes).append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text,
      });
      return { project, node };
    }),
  );
}

const indexAll = Effect.flatMap(Indexer, (indexer) => indexer.indexAll());

describe("searchTerms", () => {
  test("routes 3+ character terms to trigram FTS and 2-character terms to substring search", () => {
    expect(searchTerms("저장소 결정은 SQLite, 왜?")).toEqual({
      trigram: ["저장소", "결정은", "SQLite"],
      short: [],
    });
    expect(searchTerms("DB 결정")).toEqual({ trigram: [], short: ["DB", "결정"] });
  });
});

describe("fuseRanks", () => {
  test("rewards agreement between rankings using ranks only", () => {
    const fused = fuseRanks([
      ["vector-only", "both"],
      ["both", "text-only"],
    ]);
    expect(fused.get("vector-only")).toBeCloseTo(0.5);
    expect(fused.get("both")!).toBeGreaterThan(fused.get("vector-only")!);
    expect(fused.get("text-only")!).toBeLessThan(fused.get("vector-only")!);
    expect(fuseRanks([["a"], ["a"]]).get("a")).toBeCloseTo(1);
  });
});

describe("MemorySearch.find", () => {
  test("seeds from vector and text matches, then reaches linked evidence through the graph", async () => {
    const { runtime, project, session } = await testRuntime();
    const earlier = await earlierSession(runtime, project.id, session.id);
    await runtime.runPromise(indexAll);

    const result = await runtime.runPromise(
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query: "SQLite로 결정했던 이유", projectId: project.id }),
      ),
    );
    const byId = new Map(result.matches.map((match) => [match.id, match]));
    expect(result.degraded).toEqual([]);
    expect(result.unindexed).toBe(0);
    expect(byId.get(earlier.decision.id)?.foundBy).toMatch(/vector|text/);
    expect(byId.get(earlier.result.id)).toMatchObject({
      foundBy: "graph",
      fromOtherProject: false,
    });
    expect(byId.get(earlier.result.id)?.path.map((hop) => hop.kind)).toEqual([
      "reply",
      "calls",
      "returns",
    ]);
  });

  test("falls back to text search when the embedder fails, and says so", async () => {
    const broken = Layer.succeed(Embedder, {
      identity: "broken",
      dimensions: 64,
      embed: () => Effect.fail(new EmbeddingError({ cause: new Error("model not downloaded") })),
      runtime: () => ({ kind: "other" }),
    });
    const { runtime, project, session } = await testRuntime({ embedder: broken });
    const earlier = await earlierSession(runtime, project.id, session.id);

    const result = await runtime.runPromise(
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query: "Postgres", projectId: project.id }),
      ),
    );
    expect(result.degraded).toEqual(["vector"]);
    expect(result.unindexed).toBe(4);
    expect(result.matches[0]).toMatchObject({ id: earlier.decision.id, foundBy: "text" });
  });

  test("includes other projects unless they opted out of cross-project recall", async () => {
    const { runtime, project, base } = await testRuntime();
    const shared = await otherProject(runtime, base, "다른 프로젝트도 SQLite를 쓰기로 했다");
    const excluded = await otherProject(runtime, base, "비공개 프로젝트의 SQLite 설정");
    await runtime.runPromise(
      Effect.flatMap(Projects, (projects) =>
        projects.setCrossRecallExcluded(excluded.project.id, true),
      ),
    );
    await runtime.runPromise(indexAll);

    const find = (crossProject: boolean) =>
      runtime.runPromise(
        Effect.flatMap(MemorySearch, (search) =>
          search.find({ query: "SQLite", projectId: project.id, crossProject }),
        ),
      );
    const across = await find(true);
    expect(across.matches.find((match) => match.id === shared.node.id)).toMatchObject({
      fromOtherProject: true,
      projectId: shared.project.id,
    });
    expect(across.matches.map((match) => match.id)).not.toContain(excluded.node.id);
    expect((await find(false)).matches).toEqual([]);
  });
});

describe("memory tools", () => {
  test("let the model find, read and trace earlier evidence inside a chat run", async () => {
    const { runtime, project, session, base } = await testRuntime();
    const earlier = await earlierSession(runtime, project.id, session.id);
    const hidden = await otherProject(runtime, base, "비공개 메모");
    await runtime.runPromise(
      Effect.flatMap(Projects, (projects) =>
        projects.setCrossRecallExcluded(hidden.project.id, true),
      ),
    );
    await runtime.runPromise(indexAll);

    const newSession = await runtime.runPromise(
      Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
    );
    const nodes = await runtime.runPromise(Nodes);
    const recorder = await runtime.runPromise(Recorder);
    const tools = (await runtime.runPromise(MemoryTools)).forProject(project.id);
    const question = nodes.append({
      projectId: project.id,
      sessionId: newSession.id,
      kind: "user",
      text: "우리 DB 뭐로 하기로 했었지?",
    });

    const call = (id: string, name: string, args: Readonly<Record<string, string>>) => ({
      id,
      name,
      arguments: JSON.stringify(args),
    });
    const stream = chat({
      adapter: new ScriptedTextAdapter([
        { toolCalls: [call("c1", "find_memory", { query: "SQLite 결정" })] },
        {
          toolCalls: [
            call("c2", "read_evidence", { id: earlier.decision.id }),
            call("c3", "trace_evidence", { id: earlier.result.id }),
            call("c4", "read_evidence", { id: hidden.node.id }),
          ],
        },
        { text: "이전 세션에서 SQLite로 결정했습니다." },
      ]),
      messages: [{ role: "user", content: question.text }],
      tools,
      runId: "new-run",
      middleware: [
        recorder.forRun({
          projectId: project.id,
          sessionId: newSession.id,
          runId: "new-run",
          userNodeId: question.id,
        }),
      ],
    });
    for await (const _chunk of stream) {
      // drain
    }

    const results = new Map(
      nodes
        .session(newSession.id)
        .filter((node) => node.kind === "tool_result")
        .map((node) => [node.detail.toolCallId, JSON.parse(node.text)]),
    );
    expect(results.get("c1").matches.map((match: { id: string }) => match.id)).toContain(
      earlier.decision.id,
    );
    expect(results.get("c2")).toMatchObject({
      text: earlier.decision.text,
      nextOffset: null,
      sessionId: session.id,
    });
    expect(results.get("c3").chain.map((node: { id: string }) => node.id)).toEqual([
      earlier.result.id,
      earlier.call.id,
      earlier.answer.id,
      earlier.decision.id,
    ]);
    expect(results.get("c4")).toEqual({ error: "not_found", id: hidden.node.id });
  });
});

test("Database is shared by every service in one runtime", async () => {
  const { runtime } = await testRuntime();
  const [a, b] = await runtime.runPromise(Effect.all([Database, Database]));
  expect(a.sqlite).toBe(b.sqlite);
});
