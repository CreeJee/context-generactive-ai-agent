import { createHash } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { Database } from "../src/db/database.ts";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { EmbeddingSetup } from "../src/memory/embedding/setup.ts";
import { VectorIndex } from "../src/memory/embedding/vector-index.ts";
import { Graph } from "../src/memory/graph.ts";
import { MemoryGraphMaintenance } from "../src/memory/maintenance.ts";
import { Nodes, type Node } from "../src/memory/nodes.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { testRuntime, type TestRuntimeOptions } from "./support/runtime.ts";

async function legacy(options: TestRuntimeOptions = {}) {
  const context = await testRuntime(options);
  const nodes = await context.runtime.runPromise(Nodes);
  const { sqlite } = await context.runtime.runPromise(Database);
  const at = { projectId: context.project.id, sessionId: context.session.id };
  const user = nodes.append({ ...at, kind: "user", text: "원문 SQLite 결정" });
  const empty = nodes.append({
    ...at,
    kind: "assistant",
    text: " \n\t",
    links: [{ kind: "reply", nodeId: user.id }],
  });
  const call = nodes.append({
    ...at,
    kind: "tool_call",
    text: "read_file",
    links: [{ kind: "calls", nodeId: empty.id }],
  });
  const result = nodes.append({
    ...at,
    kind: "tool_result",
    text: "CREATE TABLE",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  sqlite
    .prepare("DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = 'returns'")
    .run(call.id, result.id);
  sqlite
    .prepare("INSERT INTO edges VALUES (?, ?, 'returns', 'structure', 0.95, ?)")
    .run(result.id, call.id, result.createdAt);
  const topic = nodes.append({
    projectId: context.project.id,
    sessionId: null,
    kind: "topic",
    text: "내용 없는 응답",
  });
  const shared = nodes.append({
    projectId: context.project.id,
    sessionId: null,
    kind: "topic",
    text: "SQLite 저장소",
  });
  const protectedTopic = nodes.append({
    projectId: context.project.id,
    sessionId: null,
    kind: "topic",
    text: "사용자가 저장한 기억",
    detail: { authorizedByUserNodeId: user.id },
  });
  const untouched = nodes.append({
    projectId: context.project.id,
    sessionId: null,
    kind: "topic",
    text: "다른 독립 주제",
  });
  const link = (source: Node, target: Node, kind = "about") => {
    sqlite
      .prepare("INSERT INTO edges VALUES (?, ?, ?, 'llm', 0.8, ?)")
      .run(source.id, target.id, kind, source.createdAt);
    sqlite
      .prepare(
        "INSERT INTO interpretations (node_id, kind, target_id, status, reason, model, created_at) VALUES (?, ?, ?, 'applied', 'legacy', 'old', ?)",
      )
      .run(source.id, kind, target.id, source.createdAt);
  };
  link(empty, topic);
  link(empty, shared);
  link(user, shared);
  link(empty, protectedTopic);
  sqlite
    .prepare("INSERT INTO interpret_jobs (node_id, status, updated_at) VALUES (?, 'pending', ?)")
    .run(empty.id, empty.createdAt);
  const maintenance = await context.runtime.runPromise(MemoryGraphMaintenance);
  const config = await context.runtime.runPromise(GlobalConfig);
  const indexer = await context.runtime.runPromise(Indexer);
  const vectors = await context.runtime.runPromise(VectorIndex);
  const graph = await context.runtime.runPromise(Graph);
  return {
    ...context,
    nodes,
    sqlite,
    user,
    empty,
    call,
    result,
    topic,
    shared,
    protectedTopic,
    untouched,
    link,
    maintenance,
    config,
    indexer,
    vectors,
    graph,
  };
}

describe("automatic memory graph maintenance", () => {
  test("other fibers can run between repair batches", async () => {
    const c = await legacy();
    for (let i = 0; i < 256; i++) {
      c.nodes.append({
        projectId: c.project.id,
        sessionId: c.session.id,
        kind: "user",
        text: `유효한 문장 ${i}`,
      });
    }
    await c.runtime.runPromise(c.config.update({ embeddingDevice: "cpu" }));
    const observed: number[] = [];
    const observer = Effect.gen(function* () {
      for (;;) {
        const snapshot = yield* c.maintenance.overview;
        observed.push(snapshot.scanned);
        if (snapshot.status === "completed") return;
        yield* Effect.yieldNow;
      }
    });
    await c.runtime.runPromise(Effect.all([c.maintenance.run, observer], { concurrency: 2 }));
    const final = await c.runtime.runPromise(c.maintenance.overview);
    expect(observed.some((scanned) => scanned > 0 && scanned < final.scanned)).toBe(true);
  });

  test("a crash after saving removals resumes the queue before index size reconciliation", async () => {
    const c = await legacy();
    await c.runtime.runPromise(c.indexer.indexAll());
    const before = c.vectors.size();
    const embedder = await c.runtime.runPromise(Embedder);
    c.sqlite
      .prepare("INSERT INTO memory_graph_suppressed_nodes VALUES (?, 1, 'empty_statement_topic')")
      .run(c.topic.seq);
    c.sqlite
      .prepare("INSERT INTO memory_graph_vector_removals VALUES (?, ?)")
      .run(c.topic.seq, embedder.identity);
    await c.runtime.runPromise(c.vectors.remove([c.topic.seq]));
    await c.runtime.runPromise(c.vectors.save);
    // The process stopped here: SQLite still records the vector and the removal intent.
    const reopened = await c.reopen();
    expect(await reopened.runPromise(Effect.map(VectorIndex, (vectors) => vectors.size()))).toBe(
      before - 1,
    );
    expect(
      await reopened.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll())),
    ).toBe(0);
    const { sqlite } = await reopened.runPromise(Database);
    expect(sqlite.prepare("SELECT * FROM memory_graph_vector_removals").all()).toEqual([]);
    expect(
      sqlite.prepare("SELECT * FROM node_vectors WHERE node_seq = ?").all(c.topic.seq),
    ).toEqual([]);
  });

  test("an absent execution choice never authorizes repairs", async () => {
    const c = await legacy();
    await c.runtime.runPromise(c.maintenance.run);
    expect(c.sqlite.prepare("SELECT * FROM memory_graph_maintenance").all()).toEqual([]);
    expect(c.graph.trace(c.result.id)?.chain).toHaveLength(1);
    expect(await c.runtime.runPromise(c.maintenance.overview)).toMatchObject({
      enabled: false,
      status: "pending",
    });
  });

  test("repairs already embedded nodes while preserving originals and useful vectors", async () => {
    const c = await legacy();
    await c.runtime.runPromise(c.indexer.indexAll());
    const original = c.sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all();
    const before = c.vectors.size();
    c.sqlite.prepare("INSERT INTO node_vectors VALUES (?, 'inactive-model')").run(c.topic.seq);
    await c.runtime.runPromise(c.config.update({ embeddingDevice: "cpu" }));
    await c.runtime.runPromise(c.maintenance.run);

    expect(c.graph.trace(c.result.id)?.chain.map((node) => node.id)).toEqual([
      c.result.id,
      c.call.id,
      c.empty.id,
      c.user.id,
    ]);
    expect(c.sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all()).toEqual(original);
    expect(c.sqlite.prepare("SELECT node_seq FROM memory_graph_suppressed_nodes").all()).toEqual([
      { node_seq: c.topic.seq },
    ]);
    expect(c.vectors.size()).toBe(before - 1);
    expect(c.sqlite.prepare("SELECT * FROM memory_graph_vector_removals").all()).toEqual([
      { node_seq: c.topic.seq, embedder: "inactive-model" },
    ]);
    expect(await c.runtime.runPromise(c.indexer.indexAll())).toBe(0);
    expect(
      c.sqlite.prepare("SELECT * FROM interpret_jobs WHERE node_id = ?").get(c.empty.id),
    ).toBeUndefined();
    expect(c.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(c.sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(await c.runtime.runPromise(c.maintenance.overview)).toMatchObject({
      status: "completed",
      repairedEdges: 1,
      suppressedEdges: 3,
      retiredTopics: 1,
    });

    const search = await c.runtime.runPromise(MemorySearch);
    const found = await c.runtime.runPromise(
      search.find({ query: c.topic.text, projectId: c.project.id }),
    );
    expect(found.matches.some((match) => match.id === c.topic.id || match.id === c.empty.id)).toBe(
      false,
    );
    const state = await c.runtime.runPromise(c.maintenance.overview);
    await c.runtime.runPromise(c.maintenance.run);
    expect(await c.runtime.runPromise(c.maintenance.overview)).toEqual(state);
    const reopened = await c.reopen();
    expect(
      await reopened.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll())),
    ).toBe(0);
    expect(await reopened.runPromise(Effect.map(VectorIndex, (vectors) => vectors.size()))).toBe(
      before - 1,
    );
  });

  test("selecting an execution mode starts repairs without a manual migration command", async () => {
    const c = await legacy();
    const setup = await c.runtime.runPromise(EmbeddingSetup);
    await c.runtime.runPromise(setup.choose("auto"));
    // Wait on the same pass permit, rather than guessing how long a background job takes.
    await c.runtime.runPromise(c.maintenance.run);
    expect(await c.runtime.runPromise(setup.overview)).toMatchObject({
      maintenance: { enabled: true, status: "completed", repairedEdges: 1 },
    });
  });

  test("existing execution choices trigger maintenance on restart", async () => {
    const c = await legacy();
    await c.runtime.runPromise(c.config.update({ embeddingDevice: "gpu" }));
    const reopened = await c.reopen();
    const maintenance = await reopened.runPromise(MemoryGraphMaintenance);
    await reopened.runPromise(maintenance.run);
    expect(await reopened.runPromise(maintenance.overview)).toMatchObject({
      enabled: true,
      status: "completed",
      repairedEdges: 1,
    });
  });

  test("a failed index save resumes targeted removals without rebuilding valid vectors", async () => {
    const c = await legacy();
    await c.runtime.runPromise(c.indexer.indexAll());
    const before = c.vectors.size();
    const embedder = await c.runtime.runPromise(Embedder);
    const directory = createHash("sha256").update(embedder.identity).digest("hex").slice(0, 16);
    const blocker = join(c.storage, "vectors", directory, "index.tvim.tmp");
    mkdirSync(blocker);
    await c.runtime.runPromise(c.config.update({ embeddingDevice: "cpu" }));
    await c.runtime.runPromise(c.maintenance.run);
    expect(await c.runtime.runPromise(c.maintenance.overview)).toMatchObject({ status: "failed" });
    expect(c.sqlite.prepare("SELECT node_seq FROM memory_graph_vector_removals").all()).toEqual([
      { node_seq: c.topic.seq },
    ]);
    rmdirSync(blocker);
    const reopened = await c.reopen();
    const maintenance = await reopened.runPromise(MemoryGraphMaintenance);
    await reopened.runPromise(maintenance.run);
    expect(await reopened.runPromise(Effect.map(VectorIndex, (vectors) => vectors.size()))).toBe(
      before - 1,
    );
    expect(
      await reopened.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll())),
    ).toBe(0);
    expect(await reopened.runPromise(maintenance.overview)).toMatchObject({ status: "completed" });
  });

  test("concurrent indexing and duplicate repair requests share only batch permits", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const embedder = Layer.succeed(Embedder, {
      identity: "gated-test-64",
      dimensions: 64,
      runtime: () => ({ kind: "other" }),
      embed: (texts) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return texts.map(fakeVector);
        }),
    });
    const c = await legacy({ embedder });
    const indexing = c.runtime.runPromise(c.indexer.indexAll());
    await Effect.runPromise(Deferred.await(entered));
    await c.runtime.runPromise(c.config.update({ embeddingDevice: "cpu" }));
    const first = c.runtime.runPromise(c.maintenance.run);
    const second = c.runtime.runPromise(c.maintenance.run);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Promise.all([indexing, first, second]);
    expect(await c.runtime.runPromise(c.maintenance.overview)).toMatchObject({
      status: "completed",
      repairedEdges: 1,
      retiredTopics: 1,
    });
    expect(c.vectors.size()).toBe(4);
    expect(await c.runtime.runPromise(c.indexer.pending)).toBe(0);
    expect(
      c.sqlite
        .prepare("SELECT count(*) AS n FROM memory_graph_edge_repairs WHERE action = 'reverse'")
        .get(),
    ).toEqual({ n: 1 });
  });

  test("different users' stores retain independent consent and progress", async () => {
    const first = await legacy();
    const second = await legacy();
    await first.runtime.runPromise(first.config.update({ embeddingDevice: "cpu" }));
    await Promise.all([
      first.runtime.runPromise(first.maintenance.run),
      second.runtime.runPromise(second.maintenance.run),
    ]);
    expect(first.graph.trace(first.result.id)?.chain).toHaveLength(4);
    expect(second.graph.trace(second.result.id)?.chain).toHaveLength(1);
    expect(second.sqlite.prepare("SELECT * FROM memory_graph_maintenance").all()).toEqual([]);
  });

  test("legacy cross-session corrections become unconfirmed, same-session decisions stay applied", async () => {
    const c = await legacy();
    const another = await c.runtime.runPromise(
      Effect.flatMap(Sessions, (sessions) => sessions.create(c.project.id)),
    );
    const cross = c.nodes.append({
      projectId: c.project.id,
      sessionId: another.id,
      kind: "user",
      text: "도구 없이 1부터 60까지 써줘",
    });
    const same = c.nodes.append({
      projectId: c.project.id,
      sessionId: c.session.id,
      kind: "user",
      text: "아니 SQLite 대신 Postgres로 바꾸자",
    });
    c.link(cross, c.user, "corrects");
    c.link(same, c.user, "corrects");
    await c.runtime.runPromise(c.config.update({ embeddingDevice: "cpu" }));
    await c.runtime.runPromise(c.maintenance.run);
    expect(
      c.sqlite
        .prepare("SELECT status FROM interpretations WHERE node_id = ? AND kind = 'corrects'")
        .get(cross.id),
    ).toEqual({ status: "unconfirmed" });
    expect(
      c.sqlite
        .prepare("SELECT status FROM interpretations WHERE node_id = ? AND kind = 'corrects'")
        .get(same.id),
    ).toEqual({ status: "applied" });
  });

  test("new empty nodes create no interpretation jobs or semantic edges", async () => {
    const c = await testRuntime();
    const nodes = await c.runtime.runPromise(Nodes);
    const interpretations = await c.runtime.runPromise(Interpretations);
    const { sqlite } = await c.runtime.runPromise(Database);
    const meaningful = nodes.append({
      projectId: c.project.id,
      sessionId: c.session.id,
      kind: "user",
      text: "SQLite",
    });
    const empty = nodes.append({
      projectId: c.project.id,
      sessionId: c.session.id,
      kind: "assistant",
      text: "\u2003\n",
    });
    interpretations.record({
      nodeId: empty.id,
      targetId: meaningful.id,
      kind: "related",
      status: "applied",
      reason: "invalid",
      model: "test",
    });
    expect(
      sqlite.prepare("SELECT * FROM interpret_jobs WHERE node_id = ?").get(empty.id),
    ).toBeUndefined();
    expect(sqlite.prepare("SELECT * FROM interpretations WHERE node_id = ?").all(empty.id)).toEqual(
      [],
    );
    expect(
      await c.runtime.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll())),
    ).toBe(1);
  });
});
