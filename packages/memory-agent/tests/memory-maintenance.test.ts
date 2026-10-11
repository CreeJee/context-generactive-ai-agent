import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { describe, expect } from "vite-plus/test";
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
import { withTestPlatform } from "./support/platform.ts";

const legacy = Effect.fn("memoryMaintenance.legacy")(function* (options: TestRuntimeOptions = {}) {
  const context = yield* Effect.promise(() => testRuntime(options));
  const services = yield* context.runtime.contextEffect;
  const nodes = yield* Effect.provideContext(Nodes, services);
  const { sqlite } = yield* Effect.provideContext(Database, services);
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
  const [maintenance, config, indexer, vectors, graph] = yield* Effect.all([
    MemoryGraphMaintenance,
    GlobalConfig,
    Indexer,
    VectorIndex,
    Graph,
  ]).pipe(Effect.provideContext(services));
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
});

describe("automatic memory graph maintenance", () => {
  it.live("other fibers can run between repair batches", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      for (let i = 0; i < 256; i++) {
        c.nodes.append({
          projectId: c.project.id,
          sessionId: c.session.id,
          kind: "user",
          text: `유효한 문장 ${i}`,
        });
      }
      yield* Effect.provideContext(
        c.config.update({ embeddingDevice: "cpu" }),
        yield* c.runtime.contextEffect,
      );
      const observed: number[] = [];
      const observer = Effect.gen(function* () {
        for (;;) {
          const snapshot = yield* c.maintenance.overview;
          observed.push(snapshot.scanned);
          if (snapshot.status === "completed") return;
          yield* Effect.yieldNow;
        }
      });
      yield* Effect.provideContext(
        Effect.all([c.maintenance.run, observer], { concurrency: 2 }),
        yield* c.runtime.contextEffect,
      );
      const final = yield* Effect.provideContext(
        c.maintenance.overview,
        yield* c.runtime.contextEffect,
      );
      expect(observed.some((scanned) => scanned > 0 && scanned < final.scanned)).toBe(true);
    }).pipe(withTestPlatform),
  );

  it.live("a crash after saving removals resumes the queue before index size reconciliation", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      yield* Effect.provideContext(c.indexer.indexAll(), yield* c.runtime.contextEffect);
      const before = c.vectors.size();
      const embedder = yield* Effect.provideContext(Embedder, yield* c.runtime.contextEffect);
      c.sqlite
        .prepare("INSERT INTO memory_graph_suppressed_nodes VALUES (?, 1, 'empty_statement_topic')")
        .run(c.topic.seq);
      c.sqlite
        .prepare("INSERT INTO memory_graph_vector_removals VALUES (?, ?)")
        .run(c.topic.seq, embedder.identity);
      yield* Effect.provideContext(c.vectors.remove([c.topic.seq]), yield* c.runtime.contextEffect);
      yield* Effect.provideContext(c.vectors.save, yield* c.runtime.contextEffect);
      // The process stopped here: SQLite still records the vector and the removal intent.
      const reopened = yield* Effect.promise(() => c.reopen());
      expect(
        yield* Effect.provideContext(
          Effect.map(VectorIndex, (vectors) => vectors.size()),
          yield* reopened.contextEffect,
        ),
      ).toBe(before - 1);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* reopened.contextEffect,
        ),
      ).toBe(0);
      const { sqlite } = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
      expect(sqlite.prepare("SELECT * FROM memory_graph_vector_removals").all()).toEqual([]);
      expect(
        sqlite.prepare("SELECT * FROM node_vectors WHERE node_seq = ?").all(c.topic.seq),
      ).toEqual([]);
    }).pipe(withTestPlatform),
  );

  it.live("an absent execution choice never authorizes repairs", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      yield* Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect);
      expect(c.sqlite.prepare("SELECT * FROM memory_graph_maintenance").all()).toEqual([]);
      expect(c.graph.trace(c.result.id)?.chain).toHaveLength(1);
      expect(
        yield* Effect.provideContext(c.maintenance.overview, yield* c.runtime.contextEffect),
      ).toMatchObject({
        enabled: false,
        status: "pending",
      });
    }).pipe(withTestPlatform),
  );

  it.live("repairs already embedded nodes while preserving originals and useful vectors", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      yield* Effect.provideContext(c.indexer.indexAll(), yield* c.runtime.contextEffect);
      const original = c.sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all();
      const before = c.vectors.size();
      c.sqlite.prepare("INSERT INTO node_vectors VALUES (?, 'inactive-model')").run(c.topic.seq);
      yield* Effect.provideContext(
        c.config.update({ embeddingDevice: "cpu" }),
        yield* c.runtime.contextEffect,
      );
      yield* Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect);
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
      expect(
        yield* Effect.provideContext(c.indexer.indexAll(), yield* c.runtime.contextEffect),
      ).toBe(0);
      expect(
        c.sqlite.prepare("SELECT * FROM interpret_jobs WHERE node_id = ?").get(c.empty.id),
      ).toBeUndefined();
      expect(c.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(c.sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(
        yield* Effect.provideContext(c.maintenance.overview, yield* c.runtime.contextEffect),
      ).toMatchObject({
        status: "completed",
        repairedEdges: 1,
        suppressedEdges: 3,
        retiredTopics: 1,
      });
      const search = yield* Effect.provideContext(MemorySearch, yield* c.runtime.contextEffect);
      const found = yield* Effect.provideContext(
        search.find({ query: c.topic.text, projectId: c.project.id }),
        yield* c.runtime.contextEffect,
      );
      expect(
        found.matches.some((match) => match.id === c.topic.id || match.id === c.empty.id),
      ).toBe(false);
      const state = yield* Effect.provideContext(
        c.maintenance.overview,
        yield* c.runtime.contextEffect,
      );
      yield* Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect);
      expect(
        yield* Effect.provideContext(c.maintenance.overview, yield* c.runtime.contextEffect),
      ).toEqual(state);
      const reopened = yield* Effect.promise(() => c.reopen());
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* reopened.contextEffect,
        ),
      ).toBe(0);
      expect(
        yield* Effect.provideContext(
          Effect.map(VectorIndex, (vectors) => vectors.size()),
          yield* reopened.contextEffect,
        ),
      ).toBe(before - 1);
    }).pipe(withTestPlatform),
  );

  it.live("selecting an execution mode starts repairs without a manual migration command", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      const setup = yield* Effect.provideContext(EmbeddingSetup, yield* c.runtime.contextEffect);
      yield* Effect.provideContext(setup.choose("auto"), yield* c.runtime.contextEffect);
      // Wait on the same pass permit, rather than guessing how long a background job takes.
      yield* Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect);
      expect(
        yield* Effect.provideContext(setup.overview, yield* c.runtime.contextEffect),
      ).toMatchObject({
        maintenance: { enabled: true, status: "completed", repairedEdges: 1 },
      });
    }).pipe(withTestPlatform),
  );

  it.live("existing execution choices trigger maintenance on restart", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      yield* Effect.provideContext(
        c.config.update({ embeddingDevice: "gpu" }),
        yield* c.runtime.contextEffect,
      );
      const reopened = yield* Effect.promise(() => c.reopen());
      const maintenance = yield* Effect.provideContext(
        MemoryGraphMaintenance,
        yield* reopened.contextEffect,
      );
      yield* Effect.provideContext(maintenance.run, yield* reopened.contextEffect);
      expect(
        yield* Effect.provideContext(maintenance.overview, yield* reopened.contextEffect),
      ).toMatchObject({
        enabled: true,
        status: "completed",
        repairedEdges: 1,
      });
    }).pipe(withTestPlatform),
  );

  it.live("a failed index save resumes targeted removals without rebuilding valid vectors", () =>
    Effect.gen(function* () {
      const c = yield* legacy();
      yield* Effect.provideContext(c.indexer.indexAll(), yield* c.runtime.contextEffect);
      const before = c.vectors.size();
      const embedder = yield* Effect.provideContext(Embedder, yield* c.runtime.contextEffect);
      const services = yield* Layer.build(NodeCrypto.layer);
      const crypto = yield* Effect.provideContext(Crypto.Crypto, services);
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(embedder.identity));
      const directory = Buffer.from(digest).toString("hex").slice(0, 16);
      const blocker = (yield* Path.Path).join(c.storage, "vectors", directory, "index.tvim.tmp");
      yield* (yield* FileSystem.FileSystem).makeDirectory(blocker);
      yield* Effect.provideContext(
        c.config.update({ embeddingDevice: "cpu" }),
        yield* c.runtime.contextEffect,
      );
      yield* Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect);
      expect(
        yield* Effect.provideContext(c.maintenance.overview, yield* c.runtime.contextEffect),
      ).toMatchObject({ status: "failed" });
      expect(c.sqlite.prepare("SELECT node_seq FROM memory_graph_vector_removals").all()).toEqual([
        { node_seq: c.topic.seq },
      ]);
      yield* (yield* FileSystem.FileSystem).remove(blocker, { recursive: true });
      const reopened = yield* Effect.promise(() => c.reopen());
      const maintenance = yield* Effect.provideContext(
        MemoryGraphMaintenance,
        yield* reopened.contextEffect,
      );
      yield* Effect.provideContext(maintenance.run, yield* reopened.contextEffect);
      expect(
        yield* Effect.provideContext(
          Effect.map(VectorIndex, (vectors) => vectors.size()),
          yield* reopened.contextEffect,
        ),
      ).toBe(before - 1);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* reopened.contextEffect,
        ),
      ).toBe(0);
      expect(
        yield* Effect.provideContext(maintenance.overview, yield* reopened.contextEffect),
      ).toMatchObject({ status: "completed" });
    }).pipe(withTestPlatform),
  );

  it.live("concurrent indexing and duplicate repair requests share only batch permits", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const embedder = Layer.succeed(Embedder, {
        identity: "gated-test-384",
        dimensions: 384,
        runtime: () => ({ kind: "other" }),
        embed: (texts) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return texts.map(fakeVector);
          }),
      });
      const c = yield* legacy({ embedder });
      const indexing = yield* Effect.forkChild(
        Effect.provideContext(c.indexer.indexAll(), yield* c.runtime.contextEffect),
      );
      yield* Deferred.await(entered);
      yield* Effect.provideContext(
        c.config.update({ embeddingDevice: "cpu" }),
        yield* c.runtime.contextEffect,
      );
      const first = yield* Effect.forkChild(
        Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect),
      );
      const second = yield* Effect.forkChild(
        Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Effect.all([Fiber.join(indexing), Fiber.join(first), Fiber.join(second)]);
      expect(
        yield* Effect.provideContext(c.maintenance.overview, yield* c.runtime.contextEffect),
      ).toMatchObject({
        status: "completed",
        repairedEdges: 1,
        retiredTopics: 1,
      });
      expect(c.vectors.size()).toBe(4);
      expect(yield* Effect.provideContext(c.indexer.pending, yield* c.runtime.contextEffect)).toBe(
        0,
      );
      expect(
        c.sqlite
          .prepare("SELECT count(*) AS n FROM memory_graph_edge_repairs WHERE action = 'reverse'")
          .get(),
      ).toEqual({ n: 1 });
    }).pipe(withTestPlatform),
  );

  it.live("different users' stores retain independent consent and progress", () =>
    Effect.gen(function* () {
      const first = yield* legacy();
      const second = yield* legacy();
      yield* Effect.provideContext(
        first.config.update({ embeddingDevice: "cpu" }),
        yield* first.runtime.contextEffect,
      );
      yield* Effect.all(
        [
          Effect.provideContext(first.maintenance.run, yield* first.runtime.contextEffect),
          Effect.provideContext(second.maintenance.run, yield* second.runtime.contextEffect),
        ],
        { concurrency: "unbounded" },
      );
      expect(first.graph.trace(first.result.id)?.chain).toHaveLength(4);
      expect(second.graph.trace(second.result.id)?.chain).toHaveLength(1);
      expect(second.sqlite.prepare("SELECT * FROM memory_graph_maintenance").all()).toEqual([]);
    }).pipe(withTestPlatform),
  );

  it.live(
    "legacy cross-session corrections become unconfirmed, same-session decisions stay applied",
    () =>
      Effect.gen(function* () {
        const c = yield* legacy();
        const another = yield* Effect.provideContext(
          Effect.flatMap(Sessions, (sessions) => sessions.create(c.project.id)),
          yield* c.runtime.contextEffect,
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
        yield* Effect.provideContext(
          c.config.update({ embeddingDevice: "cpu" }),
          yield* c.runtime.contextEffect,
        );
        yield* Effect.provideContext(c.maintenance.run, yield* c.runtime.contextEffect);
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
      }).pipe(withTestPlatform),
  );

  it.live("new empty nodes create no interpretation jobs or semantic edges", () =>
    Effect.gen(function* () {
      const c = yield* Effect.promise(() => testRuntime());
      const nodes = yield* Effect.provideContext(Nodes, yield* c.runtime.contextEffect);
      const interpretations = yield* Effect.provideContext(
        Interpretations,
        yield* c.runtime.contextEffect,
      );
      const { sqlite } = yield* Effect.provideContext(Database, yield* c.runtime.contextEffect);
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
      expect(
        sqlite.prepare("SELECT * FROM interpretations WHERE node_id = ?").all(empty.id),
      ).toEqual([]);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* c.runtime.contextEffect,
        ),
      ).toBe(1);
    }).pipe(withTestPlatform),
  );
});
