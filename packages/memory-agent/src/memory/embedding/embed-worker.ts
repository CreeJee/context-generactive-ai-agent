import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import {
  Array as Arr,
  Cause,
  Effect,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { RpcServer } from "effect/rpc";
import { workerObservabilityLayer } from "../../runtime/worker-observability.ts";
import { nativeFailure, nativePromise, runNativeEffect } from "../../runtime/native-effect.ts";
import { ignoreLogged } from "../../runtime/logged-failures.ts";
import { ChunkingFailed, chunkText } from "./chunks.ts";
import { downloadProgress, type LoadReport, plannedDownload } from "./download-progress.ts";
import {
  EmbeddingRpcs,
  EmbeddingWorkerData,
  EmbeddingWorkerFailed,
  LoadEvent,
} from "./embedding-rpc.ts";
import type { EmbeddingOutput } from "./models.ts";
import { memoryPrompts } from "../prompts.ts";
// The embedding model in a worker thread: onnxruntime-node runs a session synchronously, so on the
// main thread every batch would hold up the requests the server is answering meanwhile.
import { createRequire } from "node:module";
import { workerData } from "node:worker_threads";
import type { Tensor } from "@huggingface/transformers";

// The CommonJS build, resolved next to this file: in the package in a checkout, in the runtime
// folder in the executable.
const {
  AutoConfig,
  AutoModel,
  AutoTokenizer,
  ModelRegistry,
  env,
}: typeof import("@huggingface/transformers") = createRequire(import.meta.url)(
  "@huggingface/transformers",
);

const failure = (stage: EmbeddingWorkerFailed["stage"]) => (cause: unknown) =>
  EmbeddingWorkerFailed.make({ stage, reason: String(nativeFailure(Cause.fail(cause)).cause) });

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const load = Effect.fn("EmbeddingWorker.load")(function* (
  setup: EmbeddingWorkerData,
  progress_callback: (report: LoadReport) => void,
) {
  env.cacheDir = setup.cacheDir;
  env.allowLocalModels = false;
  // Read before the download is sized, which asks for it; a few kilobytes, not counted. Not read,
  // it was not cached and could not be downloaded: the download could not be sized either.
  const config = yield* nativePromise(() => AutoConfig.from_pretrained(setup.modelId)).pipe(
    Effect.tapError(() => Effect.sync(() => progress_callback({ status: "unplanned" }))),
  );
  // A text-only load: without these configs the model loads no vision or audio encoder.
  if (setup.textOnly) Object.assign(config, { vision_config: null, audio_config: null });
  yield* Effect.flatMap(
    plannedDownload({
      registry: ModelRegistry,
      modelId: setup.modelId,
      files: {
        config,
        dtype: "fp32",
        model_file_name: setup.modelFileName,
        device: setup.devices[0],
      },
    }),
    (plan) => Effect.sync(() => progress_callback(plan)),
  );
  const tokenizer = yield* nativePromise(() =>
    AutoTokenizer.from_pretrained(setup.modelId, { progress_callback }),
  );
  /** The model on `device`, once it has run; one that loaded and then failed is disposed of. */
  const onDevice = (device: EmbeddingWorkerData["devices"][number]) =>
    nativePromise(() =>
      AutoModel.from_pretrained(setup.modelId, {
        config,
        dtype: "fp32",
        model_file_name: setup.modelFileName,
        device,
        session_options: { enableCpuMemArena: false },
        progress_callback,
      }),
    ).pipe(
      Effect.flatMap((loaded) =>
        nativePromise(() =>
          loaded(tokenizer([memoryPrompts.warmUp], { padding: true, truncation: true })),
        ).pipe(
          Effect.as({ tokenizer, model: loaded, device }),
          Effect.tapError(() =>
            nativePromise(() => loaded.dispose()).pipe(
              ignoreLogged("embedding_model_dispose_failed", { device }),
            ),
          ),
        ),
      ),
      Effect.mapError((cause) => `${device}: ${String(nativeFailure(Cause.fail(cause)).cause)}`),
      Effect.result,
    );
  // The devices are tried in order until one works.
  const tried = yield* Stream.fromIterable(setup.devices).pipe(
    Stream.mapEffect(onDevice),
    Stream.takeUntil(Result.isSuccess),
    Stream.runCollect,
  );
  return yield* Option.match(Arr.findFirst(tried, Result.isSuccess), {
    onSome: ({ success }) => Effect.succeed(success),
    onNone: () => Effect.fail(new Cause.UnknownError(new Error(Arr.getFailures(tried).join("; ")))),
  });
});
type LoadedModel = Effect.Success<ReturnType<typeof load>>;

/**
 * The outputs the readers below use; a model has the ones its output kind reads. A half-precision
 * model's are 16-bit floats.
 */
interface ModelOutputs {
  readonly last_hidden_state: Tensor;
  readonly sentence_embedding: Tensor;
}

/** One row of the model's dimensions per text, read from the outputs. */
const vectors = {
  cls: ({ last_hidden_state: hidden }) => {
    const [batch, tokens, dimensions] = hidden.dims;
    const { data } = hidden.to("float32");
    // CLS pooling: the first token's hidden state is the sentence vector.
    return Float32Array.from({ length: batch * dimensions }, (_, at) =>
      Number(data[Math.trunc(at / dimensions) * tokens * dimensions + (at % dimensions)]),
    );
  },
  "sentence-embedding": ({ sentence_embedding: pooled }) =>
    Float32Array.from(pooled.to("float32").data, Number),
} satisfies Record<EmbeddingOutput, (outputs: ModelOutputs) => Float32Array>;

/** The batch's sentence vectors, one row per text, not yet normalized. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const embed = Effect.fn("EmbeddingWorker.embed")(function* (
  { tokenizer, model }: LoadedModel,
  texts: readonly string[],
  { maxTokens, output }: EmbeddingWorkerData,
) {
  const inputs = tokenizer([...texts], { padding: true, truncation: true, max_length: maxTokens });
  // An interrupted request still waits for its session run, so the worker never disposes of the
  // model while a run is in flight.
  const outputs = yield* Effect.uninterruptible(nativePromise<ModelOutputs>(() => model(inputs)));
  // A model without the output its kind reads fails the request.
  return yield* Effect.try(() => vectors[output](outputs));
});

const handlers = EmbeddingRpcs.toLayer(
  Effect.gen(function* () {
    const setup = yield* Schema.decodeUnknownEffect(EmbeddingWorkerData)(workerData).pipe(
      Effect.mapError(failure("load")),
    );
    // Loaded once per worker; a failed load stays failed, and the host starts a new worker.
    // The worker's scope disposes of the model when the host closes the worker, so the
    // onnxruntime session is released before the thread exits rather than left to process exit.
    const scope = yield* Scope.Scope;
    // transformers.js reports a load's progress synchronously; each report goes on to the `Load`
    // stream as it is.
    const reports = yield* PubSub.unbounded<LoadReport>();
    const progress = (report: LoadReport) => PubSub.publishUnsafe(reports, report);
    const model = yield* Effect.cached(
      load(setup, progress).pipe(
        Effect.tap(({ model: loaded, device }) =>
          Scope.addFinalizer(
            scope,
            nativePromise(() => loaded.dispose()).pipe(
              ignoreLogged("embedding_model_dispose_failed", { device }),
            ),
          ),
        ),
        Effect.mapError(failure("load")),
      ),
    );
    const run = <A, E>(work: (loaded: LoadedModel) => Effect.Effect<A, E>) =>
      Effect.flatMap(model, (loaded) => work(loaded).pipe(Effect.mapError(failure("run"))));
    return EmbeddingRpcs.of({
      Load: () =>
        downloadProgress(Stream.fromPubSub(reports)).pipe(
          Stream.map((each) => LoadEvent.cases.downloading.make(each)),
          // Ends when the model has loaded, with its device.
          Stream.merge(
            Stream.fromEffect(
              Effect.map(model, (loaded) => LoadEvent.cases.loaded.make({ device: loaded.device })),
            ),
            { haltStrategy: "right" },
          ),
        ),
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
      Embed: ({ texts }) => run((loaded) => embed(loaded, texts, setup)),
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

// The worker's failed spans go to the owner thread, which puts them in defect notices and
// reports under the run that caused them.
await runNativeEffect(Layer.launch(Layer.provide(server, workerObservabilityLayer)));
