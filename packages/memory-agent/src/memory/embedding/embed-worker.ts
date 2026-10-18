import { NodeWorkerRunner } from "@effect/platform-node";
import { Cause, Effect, Layer, Result, Schema } from "effect";
import { RpcServer } from "effect/rpc";
import { nativeFailure, nativePromise, runNativeEffect } from "../../runtime/native-effect.ts";
import { ChunkingFailed, chunkText } from "./chunks.ts";
import { EmbeddingRpcs, EmbeddingWorkerData, EmbeddingWorkerFailed } from "./embedding-rpc.ts";
// The embedding model in a worker thread: onnxruntime-node runs a session synchronously, so on the
// main thread every batch would hold up the requests the server is answering meanwhile.
import { createRequire } from "node:module";
import { workerData } from "node:worker_threads";

// The CommonJS build, resolved next to this file: in the package in a checkout, in the runtime
// folder in the executable.
const { AutoModel, AutoTokenizer, env }: typeof import("@huggingface/transformers") = createRequire(
  import.meta.url,
)("@huggingface/transformers");

const failure = (stage: EmbeddingWorkerFailed["stage"]) => (cause: unknown) =>
  EmbeddingWorkerFailed.make({ stage, reason: String(nativeFailure(Cause.fail(cause)).cause) });

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const load = Effect.fn("EmbeddingWorker.load")(function* (setup: EmbeddingWorkerData) {
  env.cacheDir = setup.cacheDir;
  env.allowLocalModels = false;
  const tokenizer = yield* nativePromise(() => AutoTokenizer.from_pretrained(setup.modelId));
  const failures: string[] = [];
  for (const device of setup.devices) {
    let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        const loaded = yield* nativePromise(() =>
          AutoModel.from_pretrained(setup.modelId, {
            dtype: "fp32",
            model_file_name: setup.modelFileName,
            device,
            session_options: { enableCpuMemArena: false },
          }),
        );
        model = loaded;
        yield* nativePromise(() =>
          loaded(tokenizer(["준비"], { padding: true, truncation: true })),
        );
        return { tokenizer, model: loaded, device };
      }),
    );
    if (Result.isSuccess(outcome)) return outcome.success;
    failures.push(`${device}: ${String(nativeFailure(Cause.fail(outcome.failure)).cause)}`);
    if (model !== null) yield* nativePromise(() => model!.dispose()).pipe(Effect.ignore);
  }
  return yield* new Cause.UnknownError(new Error(failures.join("; ")));
});
type LoadedModel = Effect.Success<ReturnType<typeof load>>;

/** The batch's sentence vectors, one row per text, not yet normalized. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const embed = Effect.fn("EmbeddingWorker.embed")(function* (
  { tokenizer, model }: LoadedModel,
  texts: readonly string[],
  maxTokens: number,
) {
  const inputs = tokenizer([...texts], { padding: true, truncation: true, max_length: maxTokens });
  const { last_hidden_state: hidden } = yield* nativePromise<
    Awaited<ReturnType<LoadedModel["model"]>>
  >(() => model(inputs));
  const [batch, tokens, dimensions] = hidden.dims;
  // CLS pooling: the first token's hidden state is the sentence vector.
  const rows = new Float32Array(batch * dimensions);
  for (let row = 0; row < batch; row++) {
    const start = row * tokens * dimensions;
    rows.set(hidden.data.subarray(start, start + dimensions), row * dimensions);
  }
  return rows;
});

const handlers = EmbeddingRpcs.toLayer(
  Effect.gen(function* () {
    const setup = yield* Schema.decodeUnknownEffect(EmbeddingWorkerData)(workerData).pipe(
      Effect.mapError(failure("load")),
    );
    // Loaded once per worker; a failed load stays failed, and the host starts a new worker.
    const model = yield* Effect.cached(load(setup).pipe(Effect.mapError(failure("load"))));
    const run = <A, E>(work: (loaded: LoadedModel) => Effect.Effect<A, E>) =>
      Effect.flatMap(model, (loaded) => work(loaded).pipe(Effect.mapError(failure("run"))));
    return EmbeddingRpcs.of({
      Load: () => Effect.map(model, (loaded) => loaded.device),
      CountTokens: ({ texts }) =>
        run((loaded) =>
          Effect.try(() =>
            texts.map(
              (text) =>
                loaded
                  .tokenizer(text, { truncation: true, max_length: setup.maxTokens })
                  .input_ids.dims.at(-1) ?? 0,
            ),
          ),
        ),
      Embed: ({ texts }) => run((loaded) => embed(loaded, texts, setup.maxTokens)),
      // The tokenizer is synchronous: one text after another, nothing to overlap.
      Chunk: ({ texts }) =>
        run((loaded) =>
          Effect.forEach(texts, (text) =>
            chunkText(text, (part, specialTokens) =>
              Effect.try({
                try: () =>
                  loaded.tokenizer.encode(part, { add_special_tokens: specialTokens }).length,
                catch: () => ChunkingFailed.make({ reason: "tokenization-failed" }),
              }),
            ),
          ),
        ),
    });
  }),
);

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
// One request at a time: the session runs synchronously, and the host bounds requests the same way.
const server = RpcServer.layer(EmbeddingRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(protocol),
);

await runNativeEffect(Layer.launch(server));
