import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
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

  test("embeds statements only; tool calls and results are left to text search", async () => {
    const { runtime, project, session } = await testRuntime();
    const state = await runtime.runPromise(
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
    );
    expect(state).toEqual({ indexed: 2, pending: 0, size: 2 });
  });

  test("an index an older build filled with tool nodes keeps only the statements", async () => {
    const { runtime, project, session, reopen } = await testRuntime();
    const seqs = await runtime.runPromise(
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
        if (!cleanup) throw new Error("missing tool-node vector cleanup migration");
        sqlite.exec(cleanup);
        return { statement: statement.seq };
      }),
    );

    const restarted = await reopen();
    const after = await restarted.runPromise(
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        // The tool call's vector is dropped on open; the statement keeps its own.
        const pending = yield* indexer.pending;
        const size = (yield* VectorIndex).size();
        const nearest = yield* (yield* VectorIndex).search(fakeVector("SQLite 결정"), 1);
        return { pending, size, nearest: nearest[0]?.seq };
      }),
    );
    expect(after).toEqual({ pending: 0, size: 1, nearest: seqs.statement });
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

  test("counts what this embedder has not embedded, whatever others did", async () => {
    const { runtime, stored } = await seeded();
    const pending = await runtime.runPromise(
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const before = yield* indexer.pending;
        // A vector from another model (the other mode) does not make a node indexed for this one.
        const { sqlite } = yield* Database;
        sqlite.prepare("INSERT INTO node_vectors VALUES (?, 'another-model')").run(stored[0]!.seq);
        const withOther = yield* indexer.pending;
        yield* indexer.indexAll();
        return { before, withOther, after: yield* indexer.pending };
      }),
    );
    expect(pending).toEqual({ before: 3, withOther: 3, after: 0 });
  });

  test("settings show the choice and what it resolves to, and keep a new choice", async () => {
    const { runtime } = await testRuntime();
    const { first, chosen, saved } = await runtime.runPromise(
      Effect.gen(function* () {
        const setup = yield* EmbeddingSetup;
        const first = yield* setup.overview;
        const chosen = yield* setup.choose("gpu");
        return { first, chosen, saved: yield* (yield* GlobalConfig).read };
      }),
    );
    // The test embedder is not the local model, so nothing is checked.
    expect(first).toMatchObject({ choice: "auto", running: { kind: "other" }, next: "cpu" });
    expect(first.gpu).toEqual({ status: "unchecked" });
    expect(chosen).toMatchObject({ choice: "gpu", next: "gpu", gpu: { status: "unchecked" } });
    expect(saved.embeddingDevice).toBe("gpu");
  });
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
  test("produces normalized 384-dim vectors that rank a paraphrase above an unrelated text", async () => {
    const runtime = ManagedRuntime.make(
      Embedder.localVariant("quint8").pipe(
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

const fullModelCached = existsSync(
  join(homedir(), ".context-generactive-agent", "models", localModel.id, modelFile("fp32")),
);

describe.skipIf(!fullModelCached)("the gpu mode (downloaded full-precision model)", () => {
  test("runs on WebGPU or falls back to the CPU, with the full-precision vectors either way", async () => {
    const models = StorageRoot.layer(join(homedir(), ".context-generactive-agent"));
    // The user's own settings stay out of it: this test chooses the GPU itself.
    const settings: Settings = { embeddingDevice: "gpu" };
    const chooseGpu = Layer.succeed(GlobalConfig, {
      read: Effect.succeed(settings),
      update: () => Effect.succeed(settings),
    });
    const gpu = ManagedRuntime.make(
      Embedder.local.pipe(Layer.provide(chooseGpu), Layer.provide(models)),
    );
    const cpu = ManagedRuntime.make(Embedder.localVariant("fp32").pipe(Layer.provide(models)));
    try {
      const sentence = ["저장소는 SQLite로 결정했다."];
      const { vector, runtime, identity } = await gpu.runPromise(
        Effect.gen(function* () {
          const embedder = yield* Embedder;
          const [vector] = yield* embedder.embed(sentence);
          return { vector, runtime: embedder.runtime(), identity: embedder.identity };
        }),
      );
      const reference = await cpu.runPromise(
        Effect.flatMap(Embedder, (embedder) => embedder.embed(sentence)),
      );
      expect(runtime).toMatchObject({ kind: "local", mode: "gpu" });
      expect(["webgpu", "cpu"]).toContain(runtime.kind === "local" ? runtime.device : null);
      expect(identity).toContain("@fp32/");
      const cosine = vector!.reduce((sum, value, i) => sum + value * reference[0]![i]!, 0);
      expect(cosine).toBeGreaterThan(0.9999);
    } finally {
      await gpu.dispose();
      await cpu.dispose();
    }
  }, 120_000);
});
