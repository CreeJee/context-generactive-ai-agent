import { layer } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { homedir } from "node:os";
import { Cause, Context, Crypto, Effect, Exit, FileSystem, Layer, Path, Ref, Scope } from "effect";
import { Hex } from "effect/encoding";
import { describe, expect } from "vite-plus/test";
import { StorageRoot } from "../../src/config/storage-root.ts";
import { GlobalConfig, type Settings } from "../../src/config/global-config.ts";
import { Database } from "../../src/db/database.ts";
import { migrations } from "../../src/db/migrations.ts";
import {
  Embedder,
  EmbeddingError,
  localModel,
  modelFile,
} from "../../src/memory/embedding/embedder.ts";
import { EmbeddingSetup } from "../../src/memory/embedding/setup.ts";
import { Indexer, IndexingError } from "../../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { MorphAnalyzer } from "../../src/memory/morph/analyzer.ts";
import { Nodes, type NodeKind } from "../../src/memory/nodes.ts";
import { memoryAgentLayer } from "../../src/layers.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { fakeEmbedderLayer, fakeVector } from "../../src/testing/fake-embedder.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const texts = [
  "저장소는 SQLite로 결정했다",
  "UI에서 프로젝트를 추가하고 선택한다",
  "", // empty assistant text before tool calls: nothing to embed
  "cargo build failed: cargo not found on PATH",
];

const said = (kind: NodeKind) => (text: string) => ({ kind, text });

/**
 * Index whatever earlier tests left pending, then append `nodes` to a fresh session. The vector
 * index belongs to the whole agent, so a test sharing it counts from the returned `size`.
 */
const seeded = Effect.fnUntraced(function* (
  nodes: ReadonlyArray<{ readonly kind: NodeKind; readonly text: string }>,
) {
  const { project } = yield* TestEnv;
  yield* (yield* Indexer).indexAll();
  const session = yield* (yield* Sessions).create(project.id);
  const append = yield* Nodes;
  const size = (yield* VectorIndex).size();
  const stored = nodes.map(({ kind, text }) =>
    append.append({ projectId: project.id, sessionId: session.id, kind, text }),
  );
  return { session, size, stored };
});

const nearest = Effect.fnUntraced(function* (query: string) {
  const hits = yield* (yield* VectorIndex).search(fakeVector(query), 1);
  return hits[0]?.seq;
});

testAgent()("Indexer + VectorIndex", (it) => {
  it.effect("indexes non-empty nodes once and finds the closest one", () =>
    Effect.gen(function* () {
      const { stored } = yield* seeded(texts.map(said("user")));
      const indexer = yield* Indexer;
      expect(yield* indexer.indexAll(2)).toBe(3);
      expect(yield* indexer.indexAll()).toBe(0);
      expect(yield* nearest("cargo not found")).toBe(stored[3]!.seq);
    }),
  );

  it.effect("embeds statements only; tool calls and results are left to text search", () =>
    Effect.gen(function* () {
      const kinds = ["user", "assistant", "tool_call", "tool_result"] as const;
      const { size } = yield* seeded(kinds.map((kind) => said(kind)(`${kind} 원문`)));
      const indexer = yield* Indexer;
      expect(yield* indexer.indexAll()).toBe(2);
      expect(yield* indexer.pending).toBe(0);
      expect((yield* VectorIndex).size() - size).toBe(2);
    }),
  );

  it.effect("counts what this embedder has not embedded, whatever others did", () =>
    Effect.gen(function* () {
      const { stored } = yield* seeded(
        ["결제 모듈은 토스로 연동한다", "회의는 금요일에 한다", "배포는 화요일에 한다"].map(
          said("user"),
        ),
      );
      const indexer = yield* Indexer;
      expect(yield* indexer.pending).toBe(3);
      // A vector from another model (the other mode) does not make a node indexed for this one.
      (yield* Database).sqlite
        .prepare("INSERT INTO node_vectors VALUES (?, 'another-model')")
        .run(stored[0]!.seq);
      expect(yield* indexer.pending).toBe(3);
      yield* indexer.indexAll();
      expect(yield* indexer.pending).toBe(0);
    }),
  );

  it.effect("settings show the choice and what it resolves to, and keep a new choice", () =>
    Effect.gen(function* () {
      const setup = yield* EmbeddingSetup;
      const first = yield* setup.overview;
      const chosen = yield* setup.choose("gpu");
      // The test embedder is not the local model, so nothing is checked.
      expect(first).toMatchObject({ choice: "auto", running: { kind: "other" }, next: "cpu" });
      expect(first.gpu).toEqual({ status: "unchecked" });
      expect(chosen).toMatchObject({ choice: "gpu", next: "gpu", gpu: { status: "unchecked" } });
      expect((yield* (yield* GlobalConfig).read).embeddingDevice).toBe("gpu");
    }),
  );
});

// Each reopening block owns its agent: reopening replaces it, so later services come from `env.use`.
testAgent()("a reopened index", (it) => {
  it.effect("reopens the saved index without re-embedding", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { stored } = yield* seeded(texts.map(said("user")));
      yield* (yield* Indexer).indexAll();
      yield* env.reopen;
      const reopened = yield* env.use(
        Effect.gen(function* () {
          const size = (yield* VectorIndex).size();
          const indexed = yield* (yield* Indexer).indexAll();
          return { size, indexed, nearest: yield* nearest("SQLite 결정") };
        }),
      );
      expect(reopened).toEqual({ size: 3, indexed: 0, nearest: stored[0]!.seq });
    }),
  );
});

testAgent()("an index file that no longer matches the database", (it) => {
  it.effect("is rebuilt on open", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      yield* seeded(texts.map(said("user")));
      yield* (yield* Indexer).indexAll();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vectors = path.join(env.storage, "vectors");
      const [directory] = yield* fs.readDirectory(vectors);
      yield* fs.remove(path.join(vectors, directory!, "index.tvim"));
      yield* env.reopen;
      const reopened = yield* env.use(
        Effect.gen(function* () {
          const size = (yield* VectorIndex).size();
          return { size, indexed: yield* (yield* Indexer).indexAll() };
        }),
      );
      expect(reopened).toEqual({ size: 0, indexed: 3 });
    }),
  );
});

testAgent()("an index an older build filled with tool nodes", (it) => {
  it.effect("keeps only the statements", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const {
        stored: [statement, call],
      } = yield* seeded([
        said("user")("저장소는 SQLite로 결정했다"),
        said("tool_call")('Read {"file_path":"src/db.ts"}'),
      ]);
      // What an older build did: embed the tool call too.
      const embedder = yield* Embedder;
      const vectors = yield* VectorIndex;
      const [first, second] = yield* embedder.embed([statement!.text, call!.text]);
      yield* vectors.add([statement!.seq, call!.seq], [first!, second!]);
      yield* vectors.save;
      const { sqlite } = yield* Database;
      const mark = sqlite.prepare("INSERT INTO node_vectors VALUES (?, ?)");
      mark.run(statement!.seq, embedder.identity);
      mark.run(call!.seq, embedder.identity);
      // The migration that stopped embedding tool nodes, as an upgrade runs it.
      const cleanup = migrations.find((step) => step.includes("DELETE FROM node_vectors"));
      expect(cleanup).toBeDefined();
      sqlite.exec(cleanup!);

      yield* env.reopen;
      // The tool call's vector is dropped on open; the statement keeps its own.
      const reopened = yield* env.use(
        Effect.gen(function* () {
          const pending = yield* (yield* Indexer).pending;
          const size = (yield* VectorIndex).size();
          return { pending, size, nearest: yield* nearest("SQLite 결정") };
        }),
      );
      expect(reopened).toEqual({ pending: 0, size: 1, nearest: statement!.seq });
    }),
  );
});

/** What a second app server reports when it opens the first one's storage. */
class SecondServer extends Context.Service<SecondServer, { readonly opened: string }>()(
  "memory-agent/tests/memory/embedding/SecondServer",
) {}

// Layers memoize by reference, so the second server gets its own memo map; otherwise it would reuse
// the first agent's services instead of opening the storage again.
const secondServer = Layer.effect(
  SecondServer,
  Effect.gen(function* () {
    const { storage } = yield* TestEnv;
    // The first agent holds the index open.
    (yield* VectorIndex).size();
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.buildWithMemoMap(
            memoryAgentLayer(storage, {
              embedder: fakeEmbedderLayer,
              morphAnalyzer: MorphAnalyzer.disabled,
            }),
            yield* Layer.makeMemoMap,
            yield* Scope.Scope,
          );
          return Context.get(services, VectorIndex).size();
        }),
      ),
    );
    return { opened: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "opened" };
  }),
);

layer(secondServer.pipe(Layer.provideMerge(TestEnv.layer())), { excludeTestServices: true })(
  "a second app server on the same storage",
  (it) => {
    it.effect("is told why it cannot open the index", () =>
      Effect.gen(function* () {
        expect((yield* SecondServer).opened).toContain(
          "held by another process using the same storage root",
        );
      }),
    );
  },
);

const lateEdits = Ref.makeUnsafe<Effect.Effect<void, EmbeddingError>>(Effect.void);
const lateIdentity = "late-publication-fixture";

/** An embedder that runs `lateEdits` while it embeds, as other writers would. */
const lateEmbedder = Layer.succeed(Embedder, {
  identity: lateIdentity,
  dimensions: 384,
  runtime: () => ({ kind: "other" }),
  embed: Effect.fnUntraced(function* (texts: readonly string[]) {
    yield* yield* Ref.get(lateEdits);
    return texts.map(fakeVector);
  }),
});

testAgent({ embedder: lateEmbedder })("late embedding", (it) => {
  it.effect(
    "revalidates late embedding once per batch and preserves vector positions for unchanged nodes",
    () =>
      Effect.gen(function* () {
        const {
          stored: [stable, changed, emptied, suppressed, recorded],
        } = yield* seeded(
          [
            "unchanged SQLite statement",
            "old text before embedding",
            "text emptied during embedding",
            "suppressed during embedding",
            "recorded elsewhere during embedding",
          ].map(said("user")),
        );
        const { sqlite, atomic } = yield* Database;
        const index = yield* VectorIndex;
        /** Use the permitted text-redaction path; the immutable evidence triggers stay on. */
        const redact = (seq: number, text: string) => {
          sqlite.prepare("INSERT INTO secret_sweep_permits VALUES (?)").run(seq);
          sqlite.prepare("UPDATE nodes SET text=? WHERE seq=?").run(text, seq);
          sqlite.prepare("DELETE FROM secret_sweep_permits WHERE node_seq=?").run(seq);
        };
        yield* Ref.set(
          lateEdits,
          Effect.gen(function* () {
            // Same index owner, saved before recording: no fake mapping without a vector.
            yield* index
              .add([recorded!.seq], [fakeVector(recorded!.text)])
              .pipe(Effect.mapError((cause) => new EmbeddingError({ cause })));
            yield* index.save.pipe(Effect.mapError((cause) => new EmbeddingError({ cause })));
            yield* Effect.try({
              try: () =>
                atomic(() => {
                  redact(changed!.seq, "new current text");
                  // Referenced evidence keeps its FKs; redaction makes it no longer meaningful.
                  redact(emptied!.seq, " \t\n");
                  sqlite
                    .prepare(
                      "INSERT INTO memory_graph_suppressed_nodes(node_seq,version,reason) VALUES(?,1,'fixture')",
                    )
                    .run(suppressed!.seq);
                  sqlite
                    .prepare("INSERT INTO node_vectors VALUES(?,?)")
                    .run(recorded!.seq, lateIdentity);
                }),
              catch: (cause) => new EmbeddingError({ cause }),
            });
          }),
        );
        const indexer = yield* Indexer;
        expect(yield* indexer.indexBatch(16)).toBe(1);
        expect(index.size()).toBe(2);
        expect(yield* index.search(fakeVector(stable!.text), 1)).toMatchObject([
          { seq: stable!.seq },
        ]);
        expect(
          sqlite
            .prepare("SELECT node_seq FROM node_vectors WHERE embedder=? ORDER BY node_seq")
            .all(lateIdentity),
        ).toEqual([{ node_seq: stable!.seq }, { node_seq: recorded!.seq }]);
        expect(sqlite.prepare("SELECT node_seq FROM secret_sweep_permits").all()).toEqual([]);
        yield* Ref.set(lateEdits, Effect.void);
        expect(yield* indexer.indexBatch(16)).toBe(1);
        expect(index.size()).toBe(3);
        expect(yield* index.search(fakeVector("new current text"), 1)).toMatchObject([
          { seq: changed!.seq },
        ]);
        expect(yield* indexer.pending).toBe(0);
      }),
  );
});

testAgent()("vector publication", (it) => {
  it.effect("native publication saves before host commit and preserves its typed failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const vectors = yield* VectorIndex;
      const storage = yield* StorageRoot;
      const embedder = yield* Embedder;
      const { sqlite, atomic } = yield* Database;
      expect(vectors.backend.kind).toBe("native");
      const {
        stored: [first, second],
      } = yield* seeded(["first publication", "failed host commit"].map(said("user")));
      const file = path.join(
        storage.path,
        "vectors",
        Hex.encode(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(embedder.identity)),
        ).slice(0, 16),
        "index.tvim",
      );
      yield* vectors.publish(
        Effect.succeed({
          seqs: [first!.seq],
          vectors: [fakeVector(first!.text)],
          commit: fs.exists(file).pipe(
            Effect.flatMap((exists) =>
              Effect.try({
                try: () => {
                  expect(exists).toBe(true);
                  atomic(() =>
                    sqlite
                      .prepare("INSERT INTO node_vectors VALUES (?,?)")
                      .run(first!.seq, embedder.identity),
                  );
                },
                catch: () => IndexingError.make({ reason: "mapping-commit-failed" }),
              }),
            ),
          ),
        }),
      );
      const failure = yield* Effect.flip(
        vectors.publish(
          Effect.succeed({
            seqs: [second!.seq],
            vectors: [fakeVector(second!.text)],
            commit: Effect.fail(IndexingError.make({ reason: "mapping-commit-failed" })),
          }),
        ),
      );
      expect(failure).toMatchObject({ _tag: "IndexingError", reason: "mapping-commit-failed" });
      // Saved ahead-of-DB; existing reopen recovery repairs this, not a fake rollback.
      expect(vectors.size()).toBe(2);
      expect(
        sqlite.prepare("SELECT node_seq FROM node_vectors WHERE embedder=?").all(embedder.identity),
      ).toEqual([{ node_seq: first!.seq }]);
    }),
  );
});

// The downloaded models are the user's; these tests run only where they are already cached.
const cachedModels = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(homedir(), ".context-generactive-agent");
        const available = (file: string) =>
          fs
            .exists(path.join(root, "models", localModel.id, file))
            .pipe(Effect.orElseSucceed(() => false));
        return {
          root,
          cpu: yield* available(modelFile("quint8")),
          gpu: yield* available(modelFile("fp32")),
        };
      }).pipe(Effect.provideContext(services));
    }),
  ),
);
const models = StorageRoot.layer(cachedModels.root);
const dot = (a: Float32Array, b: Float32Array) =>
  a.reduce((sum, value, i) => sum + value * b[i]!, 0);

describe.skipIf(!cachedModels.cpu)("the local model (downloaded, quint8 on the CPU)", () => {
  layer(Embedder.localVariant("quint8").pipe(Layer.provide(models)), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("quint8", (it) => {
    it.effect(
      "produces normalized 384-dim vectors that rank a paraphrase above an unrelated text",
      () =>
        Effect.gen(function* () {
          const embedder = yield* Embedder;
          // A long text between short ones lands in its own batch; vectors still come back in order.
          const [question, , match, unrelated] = yield* embedder.embed([
            "데이터베이스는 뭘 쓰기로 했지?",
            "빌드 로그 ".repeat(2000),
            "저장소는 SQLite로 결정했다.",
            "cargo build failed because cargo was not on PATH",
          ]);
          const [alone] = yield* embedder.embed(["저장소는 SQLite로 결정했다."]);
          expect(question).toHaveLength(localModel.dimensions);
          expect(dot(question!, question!)).toBeCloseTo(1, 4);
          expect(dot(question!, match!)).toBeGreaterThan(dot(question!, unrelated!));
          // quint8 quantizes activations per batch, so batch company moves a vector slightly (~0.01).
          expect(dot(match!, alone!)).toBeGreaterThan(0.95);
          expect(dot(match!, alone!)).toBeGreaterThan(dot(question!, alone!));
        }),
      120_000,
    );
  });
});

/** The full-precision model on the CPU, to compare the gpu mode against. */
class Reference extends Context.Service<Reference, Embedder["Service"]>()(
  "memory-agent/tests/memory/embedding/Reference",
) {}

// The user's own settings stay out of it: this block chooses the GPU itself.
const chooseGpu = Layer.succeed(GlobalConfig, {
  read: Effect.succeed<Settings>({ embeddingDevice: "gpu" }),
  update: () => Effect.succeed<Settings>({ embeddingDevice: "gpu" }),
});

describe.skipIf(!cachedModels.gpu)("the gpu mode (downloaded full-precision model)", () => {
  layer(
    Layer.merge(
      Embedder.local.pipe(Layer.provide(chooseGpu)),
      Layer.effect(Reference, Effect.service(Embedder)).pipe(
        Layer.provide(Embedder.localVariant("fp32")),
      ),
    ).pipe(Layer.provide(models)),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("gpu", (it) => {
    it.effect(
      "runs on WebGPU or falls back to the CPU, with the full-precision vectors either way",
      () =>
        Effect.gen(function* () {
          const embedder = yield* Embedder;
          const sentence = ["저장소는 SQLite로 결정했다."];
          const [vector] = yield* embedder.embed(sentence);
          const runtime = embedder.runtime();
          const [reference] = yield* (yield* Reference).embed(sentence);
          expect(runtime).toMatchObject({ kind: "local", mode: "gpu" });
          expect(["webgpu", "cpu"]).toContain(runtime.kind === "local" ? runtime.device : null);
          expect(embedder.identity).toContain("@fp32/");
          expect(dot(vector!, reference!)).toBeGreaterThan(0.9999);
        }),
      120_000,
    );
  });
});
