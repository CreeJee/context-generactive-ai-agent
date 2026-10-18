import { Context, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path, Scope } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { Database } from "../../src/db/database.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { EmbeddingSetup } from "../../src/memory/embedding/setup.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { Graph } from "../../src/memory/graph.ts";
import { MemoryGraphMaintenance } from "../../src/memory/maintenance.ts";
import { supersededReadSql } from "../../src/memory/superseded-reads.ts";
import { Nodes, type Node } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import {
  type AgentServices,
  TestEnv,
  type TestEnvOptions,
  testAgent,
} from "../support/test-env.ts";

/**
 * A store written by an older version: a reversed `returns` edge, an empty answer linked to topics
 * by the model, and a pending interpretation of that empty answer.
 */
const legacy = Effect.gen(function* () {
  const { project, session } = yield* TestEnv;
  const nodes = yield* Nodes;
  const { sqlite } = yield* Database;
  const at = { projectId: project.id, sessionId: session.id };
  const user = yield* nodes.append({ ...at, kind: "user", text: "원문 SQLite 결정" });
  const empty = yield* nodes.append({
    ...at,
    kind: "assistant",
    text: " \n\t",
    links: [{ kind: "reply", nodeId: user.id }],
  });
  const call = yield* nodes.append({
    ...at,
    kind: "tool_call",
    text: "read_file",
    links: [{ kind: "calls", nodeId: empty.id }],
  });
  const result = yield* nodes.append({
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
  const topic = { projectId: project.id, sessionId: null, kind: "topic" } as const;
  const emptyTopic = yield* nodes.append({ ...topic, text: "내용 없는 응답" });
  const shared = yield* nodes.append({ ...topic, text: "SQLite 저장소" });
  const protectedTopic = yield* nodes.append({
    ...topic,
    text: "사용자가 저장한 기억",
    detail: { authorizedByUserNodeId: user.id },
  });
  yield* nodes.append({ ...topic, text: "다른 독립 주제" });
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
  link(empty, emptyTopic);
  link(empty, shared);
  link(user, shared);
  link(empty, protectedTopic);
  sqlite
    .prepare("INSERT INTO interpret_jobs (node_id, status, updated_at) VALUES (?, 'pending', ?)")
    .run(empty.id, empty.createdAt);
  return { nodes, sqlite, user, empty, call, result, topic: emptyTopic, link };
});

const run = Effect.flatMap(MemoryGraphMaintenance, (maintenance) => maintenance.run);
/**
 * The pass the agent starts on its own saw the store before `legacy` wrote into it. Forget it, as
 * if the store came from a version without repairs.
 */
const asOlderStore = run.pipe(
  Effect.andThen(Database),
  Effect.map(({ sqlite }) => sqlite.prepare("DELETE FROM memory_graph_maintenance").run()),
);
const overview = Effect.flatMap(MemoryGraphMaintenance, (maintenance) => maintenance.overview);
const indexAll = Effect.flatMap(Indexer, (indexer) => indexer.indexAll());
const vectorCount = Effect.map(VectorIndex, (vectors) => vectors.size());
const chainLength = (id: string) =>
  Effect.flatMap(Graph, (graph) => Effect.map(graph.trace(id), (trace) => trace?.chain.length));

/** Repairs scan and rewrite the whole store, so each test owns its agent. */
const alone = <E>(
  name: string,
  test: () => Effect.Effect<void, E, AgentServices | TestEnv | Scope.Scope>,
  options?: TestEnvOptions,
) => testAgent(options)("automatic memory graph maintenance", (it) => it.effect(name, test));

alone("superseded-read repairs look up file references without scanning the project", () =>
  Effect.gen(function* () {
    const { sqlite } = yield* Database;
    // Check the real query's access path, without a machine-dependent time threshold.
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${supersededReadSql}`).all(3, "read-result");
    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("node_refs_ref (ref=?)") }),
      ]),
    );
    expect(plan).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("nodes_project") }),
      ]),
    );
  }),
);

alone("other fibers can run between repair batches", () =>
  Effect.gen(function* () {
    const c = yield* legacy;
    const { project, session } = yield* TestEnv;
    for (let i = 0; i < 256; i++) {
      yield* c.nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: `유효한 문장 ${i}`,
      });
    }
    yield* asOlderStore;
    const observed: number[] = [];
    const observer = Effect.gen(function* () {
      for (;;) {
        const snapshot = yield* overview;
        observed.push(snapshot.scanned);
        if (snapshot.status === "completed") return;
        yield* Effect.yieldNow;
      }
    });
    yield* Effect.all([run, observer], { concurrency: 2 });
    const final = yield* overview;
    expect(observed.some((scanned) => scanned > 0 && scanned < final.scanned)).toBe(true);
  }),
);

alone("a crash after saving removals resumes the queue before index size reconciliation", () =>
  Effect.gen(function* () {
    const env = yield* TestEnv;
    const c = yield* legacy;
    yield* indexAll;
    const before = yield* vectorCount;
    const embedder = yield* Embedder;
    const vectors = yield* VectorIndex;
    c.sqlite
      .prepare("INSERT INTO memory_graph_suppressed_nodes VALUES (?, 1, 'empty_statement_topic')")
      .run(c.topic.seq);
    c.sqlite
      .prepare("INSERT INTO memory_graph_vector_removals VALUES (?, ?)")
      .run(c.topic.seq, embedder.identity);
    yield* vectors.remove([c.topic.seq]);
    yield* vectors.save;
    // The process stopped here: SQLite still records the vector and the removal intent.
    yield* env.reopen;
    expect(yield* env.use(vectorCount)).toBe(before - 1);
    expect(yield* env.use(indexAll)).toBe(0);
    const { sqlite } = yield* env.use(Database);
    expect(sqlite.prepare("SELECT * FROM memory_graph_vector_removals").all()).toEqual([]);
    expect(
      sqlite.prepare("SELECT * FROM node_vectors WHERE node_seq = ?").all(c.topic.seq),
    ).toEqual([]);
  }),
);

alone("repairs run without any embedding execution choice", () =>
  Effect.gen(function* () {
    const c = yield* legacy;
    yield* asOlderStore;
    yield* run;
    expect(yield* chainLength(c.result.id)).toBe(4);
    expect(yield* overview).toMatchObject({ status: "completed", repairedEdges: 1 });
  }),
);

alone("repairs already embedded nodes while preserving originals and useful vectors", () =>
  Effect.gen(function* () {
    const env = yield* TestEnv;
    const c = yield* legacy;
    yield* indexAll;
    const original = c.sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all();
    const before = yield* vectorCount;
    c.sqlite.prepare("INSERT INTO node_vectors VALUES (?, 'inactive-model')").run(c.topic.seq);
    yield* asOlderStore;
    yield* run;
    expect((yield* (yield* Graph).trace(c.result.id))?.chain.map((node) => node.id)).toEqual([
      c.result.id,
      c.call.id,
      c.empty.id,
      c.user.id,
    ]);
    expect(c.sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all()).toEqual(original);
    expect(c.sqlite.prepare("SELECT node_seq FROM memory_graph_suppressed_nodes").all()).toEqual([
      { node_seq: c.topic.seq },
    ]);
    expect(yield* vectorCount).toBe(before - 1);
    expect(c.sqlite.prepare("SELECT * FROM memory_graph_vector_removals").all()).toEqual([
      { node_seq: c.topic.seq, embedder: "inactive-model" },
    ]);
    expect(yield* indexAll).toBe(0);
    expect(
      c.sqlite.prepare("SELECT * FROM interpret_jobs WHERE node_id = ?").get(c.empty.id),
    ).toBeUndefined();
    expect(c.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(c.sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const state = yield* overview;
    expect(state).toMatchObject({
      status: "completed",
      repairedEdges: 1,
      suppressedEdges: 3,
      retiredTopics: 1,
    });
    const found = yield* (yield* MemorySearch).find({
      query: c.topic.text,
      projectId: env.project.id,
    });
    expect(found.matches.some((match) => match.id === c.topic.id || match.id === c.empty.id)).toBe(
      false,
    );
    // A second pass over a repaired store changes nothing, before or after reopening.
    yield* run;
    expect(yield* overview).toEqual(state);
    yield* env.reopen;
    expect(yield* env.use(indexAll)).toBe(0);
    expect(yield* env.use(vectorCount)).toBe(before - 1);
  }),
);

alone("an older store is repaired when the agent starts, without a manual command", () =>
  Effect.gen(function* () {
    const env = yield* TestEnv;
    yield* legacy;
    yield* asOlderStore;
    yield* env.reopen;
    // Wait on the same pass permit, rather than guessing how long a background job takes.
    yield* env.use(run);
    expect(yield* env.use(Effect.flatMap(EmbeddingSetup, (setup) => setup.overview))).toMatchObject(
      { maintenance: { status: "completed", repairedEdges: 1 } },
    );
  }),
);

alone("a failed index save resumes targeted removals without rebuilding valid vectors", () =>
  Effect.gen(function* () {
    const env = yield* TestEnv;
    const fs = yield* FileSystem.FileSystem;
    const c = yield* legacy;
    yield* indexAll;
    const before = yield* vectorCount;
    const embedder = yield* Embedder;
    const digest = yield* (yield* Crypto.Crypto).digest(
      "SHA-256",
      new TextEncoder().encode(embedder.identity),
    );
    const directory = Buffer.from(digest).toString("hex").slice(0, 16);
    const blocker = (yield* Path.Path).join(env.storage, "vectors", directory, "index.tvim.tmp");
    yield* fs.makeDirectory(blocker);
    yield* asOlderStore;
    yield* run;
    expect(yield* overview).toMatchObject({ status: "failed" });
    expect(c.sqlite.prepare("SELECT node_seq FROM memory_graph_vector_removals").all()).toEqual([
      { node_seq: c.topic.seq },
    ]);
    yield* fs.remove(blocker, { recursive: true });
    yield* env.reopen;
    yield* env.use(run);
    expect(yield* env.use(vectorCount)).toBe(before - 1);
    expect(yield* env.use(indexAll)).toBe(0);
    expect(yield* env.use(overview)).toMatchObject({ status: "completed" });
  }),
);

// The agent embeds through this gate, so indexing is held while repairs are requested twice.
const entered = Deferred.makeUnsafe<void>();
const release = Deferred.makeUnsafe<void>();
const gatedEmbedder = Layer.succeed(Embedder, {
  identity: "gated-test-384",
  dimensions: 384,
  runtime: () => ({ kind: "other" }),
  embed: (texts) =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.as(texts.map(fakeVector)),
    ),
});

alone(
  "concurrent indexing and duplicate repair requests share only batch permits",
  () =>
    Effect.gen(function* () {
      const c = yield* legacy;
      yield* asOlderStore;
      const indexing = yield* Effect.forkChild(indexAll);
      yield* Deferred.await(entered);
      const first = yield* Effect.forkChild(run);
      const second = yield* Effect.forkChild(run);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.all([Fiber.join(indexing), Fiber.join(first), Fiber.join(second)]);
      expect(yield* overview).toMatchObject({
        status: "completed",
        repairedEdges: 1,
        retiredTopics: 1,
      });
      expect(yield* vectorCount).toBe(4);
      expect(yield* (yield* Indexer).pending).toBe(0);
      expect(
        c.sqlite
          .prepare("SELECT count(*) AS n FROM memory_graph_edge_repairs WHERE action = 'reverse'")
          .get(),
      ).toEqual({ n: 1 });
    }),
  { embedder: gatedEmbedder },
);

alone(
  "cross-session corrections keep their interpretation, and version 1 demotions come back",
  () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      const c = yield* legacy;
      const another = yield* (yield* Sessions).create(project.id);
      const cross = yield* c.nodes.append({
        projectId: project.id,
        sessionId: another.id,
        kind: "user",
        text: "도구 없이 1부터 60까지 써줘",
      });
      const same = yield* c.nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "아니 SQLite 대신 Postgres로 바꾸자",
      });
      const demoted = yield* c.nodes.append({
        projectId: project.id,
        sessionId: another.id,
        kind: "user",
        text: "SQLite 말고 DuckDB로 하자",
      });
      c.link(cross, c.user, "corrects");
      c.link(same, c.user, "corrects");
      c.link(demoted, c.user, "corrects");
      // What version 1 did to a cross-session correction: archive it, demote it, drop the edge.
      c.sqlite
        .prepare(
          "INSERT INTO memory_graph_edge_repairs (version, from_id, to_id, kind, origin, weight, created_at, action) VALUES (1, ?, ?, 'corrects', 'llm', 0.8, ?, 'suppress')",
        )
        .run(demoted.id, c.user.id, demoted.createdAt);
      c.sqlite
        .prepare(
          "INSERT INTO memory_graph_interpretation_repairs SELECT 1, id, status FROM interpretations WHERE node_id = ?",
        )
        .run(demoted.id);
      c.sqlite
        .prepare("UPDATE interpretations SET status = 'unconfirmed' WHERE node_id = ?")
        .run(demoted.id);
      c.sqlite.prepare("DELETE FROM edges WHERE from_id = ?").run(demoted.id);
      yield* asOlderStore;
      yield* run;
      const status = (node: Node) =>
        c.sqlite
          .prepare("SELECT status FROM interpretations WHERE node_id = ? AND kind = 'corrects'")
          .get(node.id);
      expect(status(cross)).toEqual({ status: "applied" });
      expect(status(same)).toEqual({ status: "applied" });
      expect(status(demoted)).toEqual({ status: "applied" });
      expect(
        c.sqlite
          .prepare("SELECT kind FROM edges WHERE from_id = ? AND to_id = ?")
          .all(demoted.id, c.user.id),
      ).toEqual([{ kind: "corrects" }]);
    }),
);

/** A second agent over its own storage, beside the block's own. */
class OtherStore extends Context.Service<OtherStore, TestEnv["Service"]>()(
  "memory-agent/tests/memory/maintenance.test/OtherStore",
) {}

layer(
  Layer.merge(
    TestEnv.layer(),
    Layer.effect(OtherStore, TestEnv).pipe(Layer.provide(TestEnv.layer())),
  ),
  { excludeTestServices: true },
)("automatic memory graph maintenance across stores", (it) => {
  it.effect("different users' stores keep independent progress", () =>
    Effect.gen(function* () {
      const other = yield* OtherStore;
      // The other store's own pass has finished before its older data appears.
      yield* other.use(run);
      const first = yield* legacy;
      const second = yield* other.use(legacy.pipe(Effect.provideService(TestEnv, other)));
      yield* asOlderStore;
      yield* run;
      expect(yield* chainLength(first.result.id)).toBe(4);
      expect(yield* other.use(chainLength(second.result.id))).toBe(1);
    }),
  );
});
