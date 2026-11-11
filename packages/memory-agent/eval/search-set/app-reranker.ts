/**
 * The app's reranker (`rerankModel`) over a copy: the same files, read from the copy's `models/`
 * folder as the app reads them from its storage, on WebGPU, with the app's pair tokens
 * (`pairTokens`). The set's steps that study the reranker's input load it from here.
 */
import { createRequire } from "node:module";
import type { Tensor as TensorType } from "@huggingface/transformers";
import { Effect, Schema } from "effect";
import { type PaddedBatch } from "../../src/memory/rerank/pairs.ts";
import { rerankModel } from "../../src/memory/rerank/reranker.ts";
import { nativePromise } from "../../src/runtime/native-effect.ts";
import { path } from "../../src/runtime/synchronous-path.ts";

// The CommonJS build, as the app's rerank worker loads it.
const {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  Tensor,
  env,
}: typeof import("@huggingface/transformers") = createRequire(import.meta.url)(
  "@huggingface/transformers",
);

/** The model returned more than one logit per pair: not a single-score reranker. */
export class NotOneLogit extends Schema.TaggedError<
  NotOneLogit,
  { readonly brand: unique symbol }
>()("NotOneLogit", { dims: Schema.Array(Schema.Finite) }) {}

const useCopy = (storage: string) => {
  env.cacheDir = path.join(storage, "models");
  env.allowLocalModels = false;
};

/** The reranker's tokenizer from the copy. */
export const appRerankTokenizer = Effect.fn("searchSet.appRerankTokenizer")(function* (
  storage: string,
) {
  useCopy(storage);
  return yield* nativePromise(() => AutoTokenizer.from_pretrained(rerankModel.id));
});

/**
 * The reranker on WebGPU, disposed of when the scope closes, and a function that scores one padded
 * batch: one logit per pair.
 */
export const appReranker = Effect.fn("searchSet.appReranker")(function* (storage: string) {
  const tokenizer = yield* appRerankTokenizer(storage);
  const model = yield* Effect.acquireRelease(
    nativePromise(() =>
      AutoModelForSequenceClassification.from_pretrained(rerankModel.id, {
        dtype: "fp32",
        model_file_name: rerankModel.file,
        device: "webgpu",
        session_options: { enableCpuMemArena: false },
      }),
    ),
    (loaded) => Effect.ignore(nativePromise(() => loaded.dispose())),
  );
  const run = Effect.fn("searchSet.appReranker.run")(function* (batch: PaddedBatch) {
    // An interrupted batch still waits for its session run, so the model is never disposed of
    // while a run is in flight.
    const { logits } = yield* Effect.uninterruptible(
      nativePromise<{ readonly logits: TensorType }>(() =>
        model({
          input_ids: new Tensor("int64", batch.ids, [...batch.dims]),
          attention_mask: new Tensor("int64", batch.mask, [...batch.dims]),
        }),
      ),
    );
    const dims: ReadonlyArray<number> = logits.dims;
    if (dims[1] !== 1) return yield* NotOneLogit.make({ dims });
    return Array.from(logits.to("float32").data, Number);
  });
  return { tokenizer, run };
});
