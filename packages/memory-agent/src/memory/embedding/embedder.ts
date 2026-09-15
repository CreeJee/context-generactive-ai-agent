import { join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { StorageRoot } from "../../config/storage-root.ts";
import { requireRuntime } from "../../runtime/resources.ts";

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

type Transformers = ReturnType<typeof requireRuntime<"@huggingface/transformers">>;
interface Loaded {
  readonly tokenizer: Awaited<ReturnType<Transformers["AutoTokenizer"]["from_pretrained"]>>;
  readonly model: Awaited<ReturnType<Transformers["AutoModel"]["from_pretrained"]>>;
}

/**
 * Runs the local model with transformers.js, loaded on first use and kept. Releasing it when idle
 * was measured and dropped: in the same process the freed memory mostly stays with the allocator
 * (quint8: ~40 MB back) and each reload grows the footprint a little.
 */
const makeLocal = (variant: ModelVariant) =>
  Effect.gen(function* () {
    const storage = yield* StorageRoot;
    const cacheDir = join(storage.path, "models");
    let loading: Promise<Loaded> | null = null;

    const load = async (): Promise<Loaded> => {
      const { AutoModel, AutoTokenizer, env } = requireRuntime("@huggingface/transformers");
      env.cacheDir = cacheDir;
      env.allowLocalModels = false;
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(localModel.id),
        AutoModel.from_pretrained(localModel.id, {
          dtype: "fp32",
          model_file_name: variantFile[variant],
          // The arena keeps a batch's peak allocation for the next one; without it memory returns.
          session_options: { enableCpuMemArena: false },
        }),
      ]);
      return { tokenizer, model };
    };

    /** Runs work with the model; a failed load is tried again on the next call. */
    const use = <A>(work: (loaded: Loaded) => Promise<A>) =>
      Effect.suspend(() => {
        const pending = (loading ??= load());
        return Effect.tryPromise({
          try: () => pending.then(work),
          catch: (cause) => {
            if (loading === pending) loading = null;
            return new EmbeddingError({ cause });
          },
        });
      });

    const embedBatch = async ({ tokenizer, model }: Loaded, texts: readonly string[]) => {
      const inputs = tokenizer([...texts], {
        padding: true,
        truncation: true,
        max_length: localModel.maxTokens,
      });
      const { last_hidden_state: hidden } = await model(inputs);
      const [batch, tokens, dimensions] = hidden.dims;
      const data: Float32Array = hidden.data;
      // CLS pooling: the first token's hidden state is the sentence vector.
      return Array.from({ length: batch }, (_, row) =>
        normalize(data.slice(row * tokens * dimensions, row * tokens * dimensions + dimensions)),
      );
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const current = loading;
        loading = null;
        if (current) await current.then(({ model }) => model.dispose()).catch(() => undefined);
      }),
    );

    return {
      identity: `${localModel.id}@${variant}/cls/${localModel.maxTokens}`,
      dimensions: localModel.dimensions,
      embed: (texts: readonly string[]) =>
        use(async (loaded) => {
          const counts = texts.map(
            (text) =>
              loaded
                .tokenizer(text, { truncation: true, max_length: localModel.maxTokens })
                .input_ids.dims.at(-1) ?? 0,
          );
          const vectors: Float32Array[] = [];
          for (const batch of planBatches(counts)) {
            const embedded = await embedBatch(
              loaded,
              batch.map((index) => texts[index]!),
            );
            batch.forEach((index, position) => (vectors[index] = embedded[position]!));
          }
          return vectors;
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
