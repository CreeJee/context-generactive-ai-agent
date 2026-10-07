import { isTruthy } from "../src/truthy.ts";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { homedir } from "node:os";
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { it } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { GlobalConfig, type Settings } from "../src/config/global-config.ts";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import {
  Embedder,
  embeddingModeFor,
  gpuMemoryThreshold,
  localModel,
  modelFile,
  planBatches,
} from "../src/memory/embedding/embedder.ts";
import { EmbeddingSetup } from "../src/memory/embedding/setup.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { MorphAnalyzer } from "../src/memory/morph/analyzer.ts";
import { VectorIndex } from "../src/memory/embedding/vector-index.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { fakeEmbedderLayer, fakeVector } from "../src/testing/fake-embedder.ts";
import { testRuntime } from "./support/runtime.ts";

const texts = [
  "저장소는 SQLite로 결정했다",
  "UI에서 프로젝트를 추가하고 선택한다",
  "", // empty assistant text before tool calls: nothing to embed
  "cargo build failed: cargo not found on PATH",
];

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const seeded = Effect.fnUntraced(function* () {
  const context = yield* Effect.promise(() => testRuntime());
  const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
  const services = yield* Layer.build(platform);
  const { fs, path } = yield* Effect.gen(function* () {
    return { fs: yield* FileSystem.FileSystem, path: yield* Path.Path };
  }).pipe(Effect.provideContext(services));
  const stored = texts.map((text) =>
    nodes.append({
      projectId: context.project.id,
      sessionId: context.session.id,
      kind: "user",
      text,
    }),
  );
  return { ...context, stored, fs, path };
});

const nearest = (query: string) =>
  Effect.gen(function* () {
    const hits = yield* (yield* VectorIndex).search(fakeVector(query), 1);
    return hits[0]?.seq;
  });

describe("Indexer + VectorIndex", () => {
  it.live("indexes non-empty nodes once and finds the closest one", () =>
    Effect.gen(function* () {
      const { runtime, stored } = yield* seeded();
      const indexed = yield* Effect.provideContext(
        Effect.flatMap(Indexer, (indexer) => indexer.indexAll(2)),
        yield* runtime.contextEffect,
      );
      expect(indexed).toBe(3);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* runtime.contextEffect,
        ),
      ).toBe(0);
      expect(
        yield* Effect.provideContext(nearest("cargo not found"), yield* runtime.contextEffect),
      ).toBe(stored[3]!.seq);
    }),
  );

  it.live("reopens the saved index without re-embedding", () =>
    Effect.gen(function* () {
      const { runtime, stored, reopen } = yield* seeded();
      yield* Effect.provideContext(
        Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
        yield* runtime.contextEffect,
      );

      const restarted = yield* Effect.tryPromise({
        try: () => reopen(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(
        yield* Effect.provideContext(
          Effect.map(VectorIndex, (index) => index.size()),
          yield* restarted.contextEffect,
        ),
      ).toBe(3);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* restarted.contextEffect,
        ),
      ).toBe(0);
      expect(
        yield* Effect.provideContext(nearest("SQLite 결정"), yield* restarted.contextEffect),
      ).toBe(stored[0]!.seq);
    }),
  );

  it.live("rebuilds when the index file no longer matches the database", () =>
    Effect.gen(function* () {
      const { runtime, storage, reopen, fs, path } = yield* seeded();
      yield* Effect.provideContext(
        Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
        yield* runtime.contextEffect,
      );
      yield* Effect.tryPromise({
        try: () => runtime.dispose(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const [directory] = yield* fs.readDirectory(path.join(storage, "vectors"));
      yield* fs.remove(path.join(storage, "vectors", directory!, "index.tvim"));

      const restarted = yield* Effect.tryPromise({
        try: () => reopen(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(
        yield* Effect.provideContext(
          Effect.map(VectorIndex, (index) => index.size()),
          yield* restarted.contextEffect,
        ),
      ).toBe(0);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* restarted.contextEffect,
        ),
      ).toBe(3);
    }),
  );

  it.live("embeds statements only; tool calls and results are left to text search", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.tryPromise({
        try: () => testRuntime(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const nodes = yield* Nodes;
          for (const kind of ["user", "assistant", "tool_call", "tool_result"] as const)
            nodes.append({
              projectId: project.id,
              sessionId: session.id,
              kind,
              text: `${kind} 원문`,
            });
          const indexer = yield* Indexer;
          const indexed = yield* indexer.indexAll();
          return { indexed, pending: yield* indexer.pending, size: (yield* VectorIndex).size() };
        }),
        yield* runtime.contextEffect,
      );
      expect(state).toEqual({ indexed: 2, pending: 0, size: 2 });
    }),
  );

  it.live("an index an older build filled with tool nodes keeps only the statements", () =>
    Effect.gen(function* () {
      const { runtime, project, session, reopen } = yield* Effect.tryPromise({
        try: () => testRuntime(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const seqs = yield* Effect.provideContext(
        Effect.gen(function* () {
          const nodes = yield* Nodes;
          const statement = nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "저장소는 SQLite로 결정했다",
          });
          const call = nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "tool_call",
            text: 'Read {"file_path":"src/db.ts"}',
          });
          // What an older build did: embed the tool call too.
          const embedder = yield* Embedder;
          const vectors = yield* VectorIndex;
          const [first, second] = yield* embedder.embed([statement.text, call.text]);
          yield* vectors.add([statement.seq, call.seq], [first!, second!]);
          yield* vectors.save;
          const { sqlite } = yield* Database;
          const mark = sqlite.prepare("INSERT INTO node_vectors VALUES (?, ?)");
          mark.run(statement.seq, embedder.identity);
          mark.run(call.seq, embedder.identity);
          // The migration that stopped embedding tool nodes, as an upgrade runs it.
          const cleanup = migrations.find((step) => step.includes("DELETE FROM node_vectors"));
          if (!isTruthy(cleanup)) throw new Error("missing tool-node vector cleanup migration");
          sqlite.exec(cleanup);
          return { statement: statement.seq };
        }),
        yield* runtime.contextEffect,
      );

      const restarted = yield* Effect.tryPromise({
        try: () => reopen(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const after = yield* Effect.provideContext(
        Effect.gen(function* () {
          const indexer = yield* Indexer;
          // The tool call's vector is dropped on open; the statement keeps its own.
          const pending = yield* indexer.pending;
          const size = (yield* VectorIndex).size();
          const nearest = yield* (yield* VectorIndex).search(fakeVector("SQLite 결정"), 1);
          return { pending, size, nearest: nearest[0]?.seq };
        }),
        yield* restarted.contextEffect,
      );
      expect(after).toEqual({ pending: 0, size: 1, nearest: seqs.statement });
    }),
  );

  it.live("a second app server on the same storage is told why it cannot open the index", () =>
    Effect.gen(function* () {
      const { runtime, storage } = yield* seeded();
      yield* Effect.provideContext(
        Effect.map(VectorIndex, (index) => index.size()),
        yield* runtime.contextEffect,
      );

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              memoryAgentLayer(storage, {
                embedder: fakeEmbedderLayer,
                morphAnalyzer: MorphAnalyzer.disabled,
              }),
            );
            return yield* Effect.map(VectorIndex, (index) => index.size()).pipe(
              Effect.provideContext(services),
            );
          }),
        ),
      );
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "opened").toContain(
        "held by another process using the same storage root",
      );
    }),
  );
});

const cachedModels = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(platform);
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
const modelCached = cachedModels.cpu;

describe("how the model runs", () => {
  const plenty = gpuMemoryThreshold;
  const little = gpuMemoryThreshold - 1;
  const available = { status: "available", checkedAt: "2026-09-16T00:00:00.000Z" } as const;
  const unavailable = {
    status: "unavailable",
    checkedAt: "2026-09-16T00:00:00.000Z",
    reason: "no WebGPU device",
  } as const;

  test("auto takes the GPU only with enough memory and a WebGPU that worked", () => {
    expect(embeddingModeFor({}, plenty)).toBe("cpu");
    expect(embeddingModeFor({ gpuCheck: available }, plenty)).toBe("gpu");
    expect(embeddingModeFor({ gpuCheck: available }, little)).toBe("cpu");
    expect(embeddingModeFor({ gpuCheck: unavailable }, plenty)).toBe("cpu");
  });

  test("a choice the user made is kept whatever the machine", () => {
    expect(embeddingModeFor({ embeddingDevice: "gpu", gpuCheck: unavailable }, little)).toBe("gpu");
    expect(embeddingModeFor({ embeddingDevice: "cpu", gpuCheck: available }, plenty)).toBe("cpu");
  });

  it.live("counts what this embedder has not embedded, whatever others did", () =>
    Effect.gen(function* () {
      const { runtime, stored } = yield* seeded();
      const pending = yield* Effect.provideContext(
        Effect.gen(function* () {
          const indexer = yield* Indexer;
          const before = yield* indexer.pending;
          // A vector from another model (the other mode) does not make a node indexed for this one.
          const { sqlite } = yield* Database;
          sqlite
            .prepare("INSERT INTO node_vectors VALUES (?, 'another-model')")
            .run(stored[0]!.seq);
          const withOther = yield* indexer.pending;
          yield* indexer.indexAll();
          return { before, withOther, after: yield* indexer.pending };
        }),
        yield* runtime.contextEffect,
      );
      expect(pending).toEqual({ before: 3, withOther: 3, after: 0 });
    }),
  );

  it.live("settings show the choice and what it resolves to, and keep a new choice", () =>
    Effect.gen(function* () {
      const { runtime } = yield* Effect.tryPromise({
        try: () => testRuntime(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const { first, chosen, saved } = yield* Effect.provideContext(
        Effect.gen(function* () {
          const setup = yield* EmbeddingSetup;
          const first = yield* setup.overview;
          const chosen = yield* setup.choose("gpu");
          return { first, chosen, saved: yield* (yield* GlobalConfig).read };
        }),
        yield* runtime.contextEffect,
      );
      // The test embedder is not the local model, so nothing is checked.
      expect(first).toMatchObject({ choice: "auto", running: { kind: "other" }, next: "cpu" });
      expect(first.gpu).toEqual({ status: "unchecked" });
      expect(chosen).toMatchObject({ choice: "gpu", next: "gpu", gpu: { status: "unchecked" } });
      expect(saved.embeddingDevice).toBe("gpu");
    }),
  );
});

describe("embedding batches", () => {
  test("group texts by length so a long text is never padded together with many short ones", () => {
    const limits = { size: 4, cost: 100 * 100 };
    // Short texts fill a batch up to the size; a long one goes alone; order within is shortest first.
    expect(planBatches([10, 90, 12, 11, 13, 14], limits)).toEqual([[0, 3, 2, 4], [5], [1]]);
    expect(planBatches([100, 100], limits)).toEqual([[0], [1]]);
    expect(planBatches([50, 50, 50, 50, 50], limits)).toEqual([[0, 1, 2, 3], [4]]);
    expect(planBatches([], limits)).toEqual([]);
  });
});

describe.skipIf(!modelCached)("the local model (downloaded, quint8 on the CPU)", () => {
  it.live(
    "produces normalized 384-dim vectors that rank a paraphrase above an unrelated text",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(
          Embedder.localVariant("quint8").pipe(Layer.provide(StorageRoot.layer(cachedModels.root))),
        );
        const long = "빌드 로그 ".repeat(2000);
        const [question, match, unrelated, alone] = yield* Effect.provideContext(
          Effect.gen(function* () {
            const embedder = yield* Embedder;
            // A long text between short ones lands in its own batch; vectors still come back in order.
            const [question, , match, unrelated] = yield* embedder.embed([
              "데이터베이스는 뭘 쓰기로 했지?",
              long,
              "저장소는 SQLite로 결정했다.",
              "cargo build failed because cargo was not on PATH",
            ]);
            const [alone] = yield* embedder.embed(["저장소는 SQLite로 결정했다."]);
            return [question, match, unrelated, alone];
          }),
          services,
        );
        const dot = (a: Float32Array, b: Float32Array) =>
          a.reduce((sum, value, i) => sum + value * b[i]!, 0);
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

const fullModelCached = cachedModels.gpu;

describe.skipIf(!fullModelCached)("the gpu mode (downloaded full-precision model)", () => {
  it.live(
    "runs on WebGPU or falls back to the CPU, with the full-precision vectors either way",
    () =>
      Effect.gen(function* () {
        const models = StorageRoot.layer(cachedModels.root);
        // The user's own settings stay out of it: this test chooses the GPU itself.
        const settings: Settings = { embeddingDevice: "gpu" };
        const chooseGpu = Layer.succeed(GlobalConfig, {
          read: Effect.succeed(settings),
          update: () => Effect.succeed(settings),
        });
        const gpuServices = yield* Layer.build(
          Embedder.local.pipe(Layer.provide(chooseGpu), Layer.provide(models)),
        );
        const sentence = ["저장소는 SQLite로 결정했다."];
        const { vector, runtime, identity } = yield* Effect.provideContext(
          Effect.gen(function* () {
            const embedder = yield* Embedder;
            const [vector] = yield* embedder.embed(sentence);
            return { vector, runtime: embedder.runtime(), identity: embedder.identity };
          }),
          gpuServices,
        );
        const cpuServices = yield* Layer.build(
          Embedder.localVariant("fp32").pipe(Layer.provide(models)),
        );
        const reference = yield* Effect.provideContext(
          Effect.flatMap(Embedder, (embedder) => embedder.embed(sentence)),
          cpuServices,
        );
        expect(runtime).toMatchObject({ kind: "local", mode: "gpu" });
        expect(["webgpu", "cpu"]).toContain(runtime.kind === "local" ? runtime.device : null);
        expect(identity).toContain("@fp32/");
        const cosine = vector!.reduce((sum, value, i) => sum + value * reference[0]![i]!, 0);
        expect(cosine).toBeGreaterThan(0.9999);
      }),
    120_000,
  );
});
