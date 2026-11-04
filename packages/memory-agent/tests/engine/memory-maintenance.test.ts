import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Scope, Stream } from "effect";
import { Digest } from "effect/crypto";
import { expect } from "vite-plus/test";
import { EmbedderRuntime, Embedder } from "../../src/memory/embedding/embedder.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { supersededReadSql } from "../../src/memory/superseded-reads.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import {
  type AgentServices,
  TestEnv,
  type TestEnvOptions,
  testAgent,
} from "../support/test-env.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";
import {
  asOlderStore,
  indexAll,
  legacy,
  overview,
  run,
  vectorCount,
} from "../support/memory-maintenance.ts";

/** Repairs scan and rewrite the whole store, so each test owns its agent. */
const alone = <E>(
  name: string,
  test: () => Effect.Effect<void, E, AgentServices | TestEnv | Scope.Scope>,
  options?: TestEnvOptions,
) => testAgent(options)("automatic memory graph maintenance", (it) => it.effect(name, test));

alone("superseded-read repairs look up file references without scanning the project", () =>
  Effect.gen(function* () {
    // Check the real query's access path, without a machine-dependent time threshold.
    const plan = yield* sqlAll(`EXPLAIN QUERY PLAN ${supersededReadSql}`, 3, "read-result");
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
    yield* Effect.forEach(
      Array.from({ length: 256 }, (_, i) => `유효한 문장 ${i}`),
      (text) =>
        c.nodes.append({ projectId: project.id, sessionId: session.id, kind: "user", text }),
      { discard: true },
    );
    yield* asOlderStore;
    const observer = Stream.fromEffectRepeat(overview.pipe(Effect.tap(Effect.yieldNow))).pipe(
      Stream.takeUntil((snapshot) => snapshot.status === "completed"),
      Stream.map((snapshot) => snapshot.scanned),
      Stream.runCollect,
    );
    const [, observed] = yield* Effect.all([run, observer], { concurrency: 2 });
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
    yield* sqlRun(
      "INSERT INTO memory_graph_suppressed_nodes VALUES (?, 1, 'empty_statement_topic')",
      c.topic.seq,
    );
    yield* sqlRun(
      "INSERT INTO memory_graph_vector_removals VALUES (?, ?)",
      c.topic.seq,
      embedder.identity,
    );
    yield* vectors.remove([c.topic.seq]);
    yield* vectors.save;
    // The process stopped here: SQLite still records the vector and the removal intent.
    yield* env.reopen;
    expect(yield* env.use(vectorCount)).toBe(before - 1);
    expect(yield* env.use(indexAll)).toBe(0);
    expect(yield* sqlAll("SELECT * FROM memory_graph_vector_removals")).toEqual([]);
    expect(yield* sqlAll("SELECT * FROM node_vectors WHERE node_seq = ?", c.topic.seq)).toEqual([]);
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
    const digest = yield* (yield* Digest.Digest).digest(
      Digest.sha256,
      new TextEncoder().encode(embedder.identity),
    );
    const directory = Buffer.from(digest).toString("hex").slice(0, 16);
    const blocker = (yield* Path.Path).join(env.storage, "vectors", directory, "index.tvim.tmp");
    yield* fs.makeDirectory(blocker);
    yield* asOlderStore;
    yield* run;
    expect(yield* overview).toMatchObject({ status: "failed" });
    expect(yield* sqlAll("SELECT node_seq FROM memory_graph_vector_removals")).toEqual([
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
  runtime: () => EmbedderRuntime.other(),
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
      yield* legacy;
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
        yield* sqlGet(
          "SELECT count(*) AS n FROM memory_graph_edge_repairs WHERE action = 'reverse'",
        ),
      ).toEqual({ n: 1 });
    }),
  { embedder: gatedEmbedder },
);
