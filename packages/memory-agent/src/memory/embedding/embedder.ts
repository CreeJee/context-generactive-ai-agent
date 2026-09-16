import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "../../config/storage-root.ts";
import { runtimeWorker } from "../../runtime/resources.ts";

export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly cause: unknown;
}> {}

export interface EmbedderApi {
  /** Changes whenever vectors from this embedder are not comparable with earlier ones. */
  readonly identity: string;
  readonly dimensions: number;
  /** L2-normalized vectors, one per text, in order. */
  readonly embed: (texts: readonly string[]) => Effect.Effect<Float32Array[], EmbeddingError>;
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
 * Model files published for the model. `quint8` is the default (2026-09-15): about 1 GB less
 * memory and twice as fast as `fp32`, for MRR 0.831 instead of 0.852 on the Korean recall set.
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
const Reply = Schema.Union(
  Schema.Struct({
    id: Schema.Number,
    kind: Schema.Literal("counts"),
    counts: Schema.Array(Schema.Number),
  }),
  Schema.Struct({
    id: Schema.Number,
    kind: Schema.Literal("rows"),
    rows: Schema.instanceOf(Float32Array),
  }),
  Schema.Struct({
    id: Schema.Number,
    kind: Schema.Literal("failed"),
    /** `load`: the model never loaded, so the next request starts a new worker to try again. */
    stage: Schema.Literal("load", "run"),
    reason: Schema.String,
  }),
);
type Reply = typeof Reply.Type;
const decodeReply = Schema.decodeUnknownSync(Reply);

/**
 * Runs the local model with transformers.js in a worker thread, started on first use and kept.
 * onnxruntime-node runs a session synchronously, so on the main thread a backlog of batches held up
 * every request the server answered meanwhile: a start with ~1,100 nodes to embed kept settings
 * waiting for over a minute. Releasing the model when idle was measured and dropped: the freed
 * memory mostly stays with the allocator (quint8: ~40 MB back) and each reload grows the footprint a
 * little.
 */
const makeLocal = (variant: ModelVariant) =>
  Effect.gen(function* () {
    const storage = yield* StorageRoot;
    const workerData = {
      cacheDir: join(storage.path, "models"),
      modelId: localModel.id,
      modelFileName: variantFile[variant],
      maxTokens: localModel.maxTokens,
    };
    let worker: Worker | null = null;
    let nextId = 1;
    const pending = new Map<number, (reply: Reply) => void>();

    const stop = (reason: string) => {
      const current = worker;
      worker = null;
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
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
        // A model that failed to load is tried again by the next request, in a new worker.
        if (reply.kind === "failed" && reply.stage === "load") lost();
        // An idle worker must not keep the process alive; one with requests in flight must.
        else if (pending.size === 0) created.unref();
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
          throw new Error("the embedding worker answered a count with vectors");
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
          throw new Error("the embedding worker answered an embedding with counts");
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => void (await stop("embedder stopped"))),
    );

    return {
      identity: `${localModel.id}@${variant}/cls/${localModel.maxTokens}`,
      dimensions: localModel.dimensions,
      embed: (texts: readonly string[]) =>
        Effect.tryPromise({
          try: async () => {
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
          catch: (cause) => new EmbeddingError({ cause }),
        }),
    } satisfies EmbedderApi;
  });

export class Embedder extends Context.Tag("memory-agent/Embedder")<Embedder, EmbedderApi>() {
  /** The local granite model, cached under `<storage>/models`. */
  static readonly local = Layer.scoped(Embedder, makeLocal("quint8"));
  /** The same model from another published file, to compare quality and memory. */
  static readonly localVariant = (variant: ModelVariant) =>
    Layer.scoped(Embedder, makeLocal(variant));
}
