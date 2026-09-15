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
  /** fp32 reproduces the model card scores; the published int8 file drifts by ~0.05 cosine. */
  dtype: "fp32",
  /** Long tool output is truncated here to bound memory; the full text stays in the node. */
  maxTokens: 8192,
  batchSize: 16,
} as const;

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

/** Runs the local model with transformers.js. Loads on first use so startup stays fast. */
const makeLocal = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const cacheDir = join(storage.path, "models");

  const load = yield* Effect.cached(
    Effect.tryPromise({
      try: async () => {
        const { AutoModel, AutoTokenizer, env } = requireRuntime("@huggingface/transformers");
        env.cacheDir = cacheDir;
        env.allowLocalModels = false;
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(localModel.id),
          AutoModel.from_pretrained(localModel.id, { dtype: localModel.dtype }),
        ]);
        return { tokenizer, model };
      },
      catch: (cause) => new EmbeddingError({ cause }),
    }),
  );

  const embedBatch = (texts: readonly string[]) =>
    Effect.flatMap(load, ({ tokenizer, model }) =>
      Effect.tryPromise({
        try: async () => {
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
            normalize(
              data.slice(row * tokens * dimensions, row * tokens * dimensions + dimensions),
            ),
          );
        },
        catch: (cause) => new EmbeddingError({ cause }),
      }),
    );

  return {
    identity: `${localModel.id}@${localModel.dtype}/cls/${localModel.maxTokens}`,
    dimensions: localModel.dimensions,
    embed: (texts: readonly string[]) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(texts.length / localModel.batchSize) }, (_, index) =>
          texts.slice(index * localModel.batchSize, (index + 1) * localModel.batchSize),
        ),
        embedBatch,
        { concurrency: 1 },
      ).pipe(Effect.map((batches) => batches.flat())),
  } satisfies EmbedderApi;
});

export class Embedder extends Context.Tag("memory-agent/Embedder")<Embedder, EmbedderApi>() {
  /** The local granite model, cached under `<storage>/models`. */
  static readonly local = Layer.effect(Embedder, makeLocal);
}
