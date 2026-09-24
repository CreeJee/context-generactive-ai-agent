import { totalmem } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { GlobalConfig, type GpuCheck, type Settings } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { runtimeWorker } from "../../runtime/resources.ts";

export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly cause: unknown;
}> {}

/** Where the model runs. */
export const EmbeddingDevice = Schema.Literals(["cpu", "webgpu"]);
export type EmbeddingDevice = typeof EmbeddingDevice.Type;

/**
 * How the local model runs; chosen when the app starts.
 * - `cpu`: the quantized file on the CPU. The least memory; it takes several cores while it works.
 * - `gpu`: the full-precision file on WebGPU. A fraction of the CPU for about 1–1.6 GB more memory,
 *   and full-precision vectors. Where WebGPU is missing the same file runs on the CPU: the vectors
 *   are the same (measured cosine 1.0), only slower.
 */
export type EmbeddingMode = "cpu" | "gpu";

/** How an embedder runs, for settings. Test and evaluation embedders are `other`. */
export type EmbedderRuntime =
  | {
      readonly kind: "local";
      readonly mode: EmbeddingMode;
      /** Null until the model has loaded. */
      readonly device: EmbeddingDevice | null;
    }
  | { readonly kind: "other" };

export interface EmbedderApi {
  /** Changes whenever vectors from this embedder are not comparable with earlier ones. */
  readonly identity: string;
  readonly dimensions: number;
  /** L2-normalized vectors, one per text, in order. */
  readonly embed: (texts: readonly string[]) => Effect.Effect<Float32Array[], EmbeddingError>;
  readonly runtime: () => EmbedderRuntime;
}

/** Chosen 2026-09: Apache-2.0, 384 dims, 32k context, Korean in its enhanced-support set. */
export const localModel = {
  id: "ibm-granite/granite-embedding-97m-multilingual-r2",
  dimensions: 384,
  /**
   * Longest input embedded. Attention memory grows with the square of the length (4096 tokens
   * already takes ~650 MB more than a short text), so long tool output is embedded from its start;
   * the full text stays in the node and in text and morpheme search.
   */
  maxTokens: 2048,
  /** Texts per batch at most. */
  batchSize: 16,
  /**
   * A batch is padded to its longest text, so it costs about count × longest² in attention. Batches
   * stay within the cost of one text of `maxTokens`: sixteen 512-token texts, or one long one.
   */
  batchCost: 2048 * 2048,
} as const;

/**
 * Model files published for the model. On the CPU `quint8` has about 1 GB less memory and is twice
 * as fast as `fp32`, for MRR 0.831 instead of 0.852 on the Korean recall set; the `cpu` mode uses it.
 * The `gpu` mode runs `fp32`, which WebGPU runs as fast as the CPU runs `quint8`.
 */
export type ModelVariant = "fp32" | "quint8";
const variantFile = {
  fp32: "model",
  quint8: "model_quint8_avx2",
} satisfies Record<ModelVariant, string>;

/** Where a variant's ONNX file sits in the model cache, relative to the model's folder. */
export const modelFile = (variant: ModelVariant) => `onnx/${variantFile[variant]}.onnx`;

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

/**
 * Groups text indices into batches by token length so no batch pads short texts up to a long one:
 * shortest first, each batch within {@link localModel.batchSize} texts and
 * {@link localModel.batchCost}.
 */
export function planBatches(
  tokenCounts: readonly number[],
  limits: { readonly size: number; readonly cost: number } = {
    size: localModel.batchSize,
    cost: localModel.batchCost,
  },
): number[][] {
  const order = tokenCounts
    .map((_, index) => index)
    .sort((a, b) => tokenCounts[a]! - tokenCounts[b]!);
  const batches: number[][] = [];
  let current: number[] = [];
  let longest = 0;
  for (const index of order) {
    const count = tokenCounts[index]!;
    const wider = Math.max(longest, count);
    if (
      current.length > 0 &&
      (current.length + 1 > limits.size || (current.length + 1) * wider * wider > limits.cost)
    ) {
      batches.push(current);
      current = [];
      longest = 0;
    }
    current.push(index);
    longest = Math.max(longest, count);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Replies from `embed-worker.mjs`. */
const Reply = Schema.Union([
  Schema.Struct({
    id: Schema.Finite,
    kind: Schema.Literal("counts"),
    counts: Schema.Array(Schema.Finite),
  }),
  Schema.Struct({
    id: Schema.Finite,
    kind: Schema.Literal("rows"),
    rows: Schema.instanceOf(Float32Array),
  }),
  Schema.Struct({
    id: Schema.Finite,
    kind: Schema.Literal("failed"),
    /** `load`: the model never loaded, so the next request starts a new worker to try again. */
    stage: Schema.Literals(["load", "run"]),
    reason: Schema.String,
  }),
  /** Sent unasked once the model runs, with the device it runs on. */
  Schema.Struct({ id: Schema.Finite, kind: Schema.Literal("loaded"), device: EmbeddingDevice }),
]);
type Reply = typeof Reply.Type;
const decodeReply = Schema.decodeUnknownSync(Reply);

/** Which file to load, and the devices to try it on in order. */
interface ModelSetup {
  readonly variant: ModelVariant;
  readonly devices: readonly EmbeddingDevice[];
}

const modes = {
  cpu: { variant: "quint8", devices: ["cpu"] },
  gpu: { variant: "fp32", devices: ["webgpu", "cpu"] },
} satisfies Record<EmbeddingMode, ModelSetup>;

/**
 * From this much memory `auto` runs the model on the GPU (where WebGPU was found to work). Measured
 * 2026-09 on Apple Silicon: the full-precision model on WebGPU peaks at 2.9 GB against 1.3 GB for
 * the quantized one on the CPU, and uses 0.7–0.8 cores against 3.4–3.7.
 */
export const gpuMemoryThreshold = 16 * 1024 ** 3;

/** The mode the app runs with, given the settings it starts with. */
export function embeddingModeFor(
  settings: Settings,
  memoryBytes: number = totalmem(),
): EmbeddingMode {
  switch (settings.embeddingDevice ?? "auto") {
    case "cpu":
      return "cpu";
    case "gpu":
      return "gpu";
    case "auto":
      return memoryBytes >= gpuMemoryThreshold && settings.gpuCheck?.status === "available"
        ? "gpu"
        : "cpu";
  }
}

/**
 * The model in a worker thread, started on the first request and kept. onnxruntime-node runs a
 * session synchronously, so on the main thread a backlog of batches held up every request the
 * server answered meanwhile: a start with ~1,100 nodes to embed kept settings waiting for over a
 * minute. Releasing the model when idle was measured and dropped: the freed memory mostly stays with
 * the allocator (quint8: ~40 MB back) and each reload grows the footprint a little.
 */
function modelWorker(cacheDir: string, setup: ModelSetup) {
  const workerData = {
    cacheDir,
    modelId: localModel.id,
    modelFileName: variantFile[setup.variant],
    maxTokens: localModel.maxTokens,
    devices: setup.devices,
  };
  let worker: Worker | null = null;
  let device: EmbeddingDevice | null = null;
  let nextId = 1;
  const pending = new Map<number, (reply: Reply) => void>();

  const stop = (reason: string) => {
    const current = worker;
    worker = null;
    device = null;
    for (const [id, resolve] of pending) resolve({ id, kind: "failed", stage: "run", reason });
    pending.clear();
    return current?.terminate();
  };

  const start = () => {
    const created = new Worker(runtimeWorker("embed-worker"), { workerData });
    const lost = () => {
      if (worker === created) void stop("embedding worker stopped");
    };
    created.on("message", (message) => {
      const reply = decodeReply(message);
      switch (reply.kind) {
        case "loaded":
          if (worker === created) device = reply.device;
          return;
        case "counts":
        case "rows":
        case "failed":
          pending.get(reply.id)?.(reply);
          pending.delete(reply.id);
          // A model that failed to load is tried again by the next request, in a new worker.
          if (reply.kind === "failed" && reply.stage === "load") lost();
          // An idle worker must not keep the process alive; one with requests in flight must.
          else if (pending.size === 0) created.unref();
      }
    });
    created.on("error", lost);
    created.on("exit", lost);
    created.unref();
    return created;
  };

  const request = (kind: "count" | "embed", texts: readonly string[]) =>
    new Promise<Reply>((resolve) => {
      const current = (worker ??= start());
      const id = nextId++;
      pending.set(id, resolve);
      current.ref();
      current.postMessage({ id, kind, texts });
    });

  const tokenCounts = async (texts: readonly string[]) => {
    const reply = await request("count", texts);
    switch (reply.kind) {
      case "counts":
        return reply.counts;
      case "failed":
        throw new Error(reply.reason);
      case "rows":
      case "loaded":
        throw new Error("the embedding worker answered a count with something else");
    }
  };

  /** One batch's CLS rows, `texts.length` × {@link localModel.dimensions}, not normalized. */
  const embedBatch = async (texts: readonly string[]) => {
    const reply = await request("embed", texts);
    switch (reply.kind) {
      case "rows":
        return reply.rows;
      case "failed":
        throw new Error(reply.reason);
      case "counts":
      case "loaded":
        throw new Error("the embedding worker answered an embedding with something else");
    }
  };

  return {
    device: () => device,
    stop,
    embed: async (texts: readonly string[]) => {
      const vectors: Float32Array[] = [];
      if (texts.length === 0) return vectors;
      for (const batch of planBatches(await tokenCounts(texts))) {
        const rows = await embedBatch(batch.map((index) => texts[index]!));
        batch.forEach((index, position) => {
          const start = position * localModel.dimensions;
          vectors[index] = normalize(rows.slice(start, start + localModel.dimensions));
        });
      }
      return vectors;
    },
  };
}

/** What a local embedder is for: the app (run as settings say) or evaluating a model file. */
type LocalPurpose =
  | { readonly kind: "app"; readonly mode: EmbeddingMode }
  | { readonly kind: "evaluation" };

const makeLocal = (setup: ModelSetup, purpose: LocalPurpose) =>
  Effect.gen(function* () {
    const storage = yield* StorageRoot;
    const model = modelWorker(join(storage.path, "models"), setup);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => void (await model.stop("embedder stopped"))),
    );
    return {
      identity: `${localModel.id}@${setup.variant}/cls/${localModel.maxTokens}`,
      dimensions: localModel.dimensions,
      runtime: (): EmbedderRuntime => {
        switch (purpose.kind) {
          case "app":
            return { kind: "local", mode: purpose.mode, device: model.device() };
          case "evaluation":
            return { kind: "other" };
        }
      },
      embed: (texts: readonly string[]) =>
        Effect.tryPromise({
          try: () => model.embed(texts),
          catch: (cause) => new EmbeddingError({ cause }),
        }),
    } satisfies EmbedderApi;
  });

/**
 * Whether the full-precision model loads and runs on WebGPU here, in a worker of its own that ends
 * afterwards. Downloads that model file first when it is not cached yet.
 */
export const checkGpu = (storageRoot: string) =>
  Effect.tryPromise({
    try: async (): Promise<GpuCheck> => {
      const model = modelWorker(join(storageRoot, "models"), {
        variant: "fp32",
        devices: ["webgpu"],
      });
      try {
        await model.embed(["준비"]);
        return model.device() === "webgpu"
          ? { status: "available", checkedAt: new Date().toISOString() }
          : {
              status: "unavailable",
              checkedAt: new Date().toISOString(),
              reason: "no WebGPU device",
            };
      } catch (error) {
        return {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
      } finally {
        await model.stop("GPU check done");
      }
    },
    catch: (cause) => new EmbeddingError({ cause }),
  });

export class Embedder extends Context.Service<Embedder, EmbedderApi>()("memory-agent/Embedder") {
  /** The local granite model, cached under `<storage>/models`, run the way the settings say. */
  static readonly local = Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const mode = embeddingModeFor(yield* (yield* GlobalConfig).read);
      return yield* makeLocal(modes[mode], { kind: "app", mode });
    }),
  );
  /** Another published file on the CPU, to compare quality and memory. */
  static readonly localVariant = (variant: ModelVariant) =>
    Layer.effect(Embedder, makeLocal({ variant, devices: ["cpu"] }, { kind: "evaluation" }));
}
