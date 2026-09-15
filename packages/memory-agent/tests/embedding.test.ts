import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Embedder, localModel, modelFile, planBatches } from "../src/memory/embedding/embedder.ts";
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

async function seeded() {
  const context = await testRuntime();
  const nodes = await context.runtime.runPromise(Nodes);
  const stored = texts.map((text) =>
    nodes.append({
      projectId: context.project.id,
      sessionId: context.session.id,
      kind: "user",
      text,
    }),
  );
  return { ...context, stored };
}

const nearest = (query: string) =>
  Effect.gen(function* () {
    const hits = yield* (yield* VectorIndex).search(fakeVector(query), 1);
    return hits[0]?.seq;
  });

describe("Indexer + VectorIndex", () => {
  test("indexes non-empty nodes once and finds the closest one", async () => {
    const { runtime, stored } = await seeded();
    const indexed = await runtime.runPromise(
      Effect.flatMap(Indexer, (indexer) => indexer.indexAll(2)),
    );
    expect(indexed).toBe(3);
    expect(await runtime.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll()))).toBe(
      0,
    );
    expect(await runtime.runPromise(nearest("cargo not found"))).toBe(stored[3]!.seq);
  });

  test("reopens the saved index without re-embedding", async () => {
    const { runtime, stored, reopen } = await seeded();
    await runtime.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll()));

    const restarted = await reopen();
    expect(await restarted.runPromise(Effect.map(VectorIndex, (index) => index.size()))).toBe(3);
    expect(
      await restarted.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll())),
    ).toBe(0);
    expect(await restarted.runPromise(nearest("SQLite 결정"))).toBe(stored[0]!.seq);
  });

  test("rebuilds when the index file no longer matches the database", async () => {
    const { runtime, storage, reopen } = await seeded();
    await runtime.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll()));
    await runtime.dispose();
    const [directory] = readdirSync(join(storage, "vectors"));
    rmSync(join(storage, "vectors", directory!, "index.tvim"));

    const restarted = await reopen();
    expect(await restarted.runPromise(Effect.map(VectorIndex, (index) => index.size()))).toBe(0);
    expect(
      await restarted.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll())),
    ).toBe(3);
  });

  test("a second app server on the same storage is told why it cannot open the index", async () => {
    const { runtime, storage } = await seeded();
    await runtime.runPromise(Effect.map(VectorIndex, (index) => index.size()));

    const second = ManagedRuntime.make(
      memoryAgentLayer(storage, {
        embedder: fakeEmbedderLayer,
        morphAnalyzer: MorphAnalyzer.disabled,
      }),
    );
    const exit = await second.runPromiseExit(Effect.map(VectorIndex, (index) => index.size()));
    await second.dispose().catch(() => {});
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "opened").toContain(
      "held by another process using the same storage root",
    );
  });
});

const modelCached = existsSync(
  join(homedir(), ".context-generactive-agent", "models", localModel.id, modelFile("quint8")),
);

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

describe.skipIf(!modelCached)("Embedder.local (downloaded model)", () => {
  test("produces normalized 384-dim vectors that rank a paraphrase above an unrelated text", async () => {
    const runtime = ManagedRuntime.make(
      Embedder.local.pipe(
        Layer.provide(StorageRoot.layer(join(homedir(), ".context-generactive-agent"))),
      ),
    );
    try {
      const long = "빌드 로그 ".repeat(2000);
      const [question, match, unrelated, alone] = await runtime.runPromise(
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
      );
      const dot = (a: Float32Array, b: Float32Array) =>
        a.reduce((sum, value, i) => sum + value * b[i]!, 0);
      expect(question).toHaveLength(localModel.dimensions);
      expect(dot(question!, question!)).toBeCloseTo(1, 4);
      expect(dot(question!, match!)).toBeGreaterThan(dot(question!, unrelated!));
      // quint8 quantizes activations per batch, so batch company moves a vector slightly (~0.01).
      expect(dot(match!, alone!)).toBeGreaterThan(0.95);
      expect(dot(match!, alone!)).toBeGreaterThan(dot(question!, alone!));
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});
