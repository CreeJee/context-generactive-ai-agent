import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { Cause, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect";
import { RpcServer } from "effect/rpc";
import { workerFailedSpansLayer } from "../../runtime/failed-spans.ts";
import { nativeFailure, nativePromise, runNativeEffect } from "../../runtime/native-effect.ts";
import { ignoreLogged } from "../../runtime/logged-failures.ts";
import { downloadProgress } from "../embedding/download-progress.ts";
import { RerankLoadEvent, RerankRpcs, RerankWorkerData, RerankWorkerFailed } from "./rerank-rpc.ts";
// The reranker in a worker thread: onnxruntime-node runs a session synchronously, so on the main
// thread a batch would hold up the requests the server is answering meanwhile.
import { createRequire } from "node:module";
import { workerData } from "node:worker_threads";
import type { ProgressCallback, ProgressInfo, Tensor } from "@huggingface/transformers";

// The CommonJS build, resolved next to this file: in the package in a checkout, in the runtime
// folder in the executable.
const {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
}: typeof import("@huggingface/transformers") = createRequire(import.meta.url)(
  "@huggingface/transformers",
);

const failure = (stage: RerankWorkerFailed["stage"]) => (cause: unknown) =>
  RerankWorkerFailed.make({ stage, reason: String(nativeFailure(Cause.fail(cause)).cause) });

/** The model returned more than one logit per pair: not a single-score reranker. */
class NotOneLogit extends Schema.TaggedError<NotOneLogit, { readonly brand: unique symbol }>()(
  "NotOneLogit",
  { dims: Schema.Array(Schema.Finite) },
) {}

/** The model's relevance logits for the pairs, one per text. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const score = Effect.fn("RerankWorker.score")(function* (
  { tokenizer, model }: LoadedModel,
  query: string,
  texts: readonly string[],
  { maxTokens }: RerankWorkerData,
) {
  const inputs = tokenizer(
    texts.map(() => query),
    { text_pair: [...texts], padding: true, truncation: true, max_length: maxTokens },
  );
  // An interrupted request still waits for its session run, so the worker never disposes of the
  // model while a run is in flight.
  const { logits } = yield* Effect.uninterruptible(
    nativePromise<{ readonly logits: Tensor }>(() => model(inputs)),
  );
  const dims: ReadonlyArray<number> = logits.dims;
  if (dims[1] !== 1) return yield* NotOneLogit.make({ dims });
  return Array.from(logits.to("float32").data, Number);
});

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const load = Effect.fn("RerankWorker.load")(function* (
  setup: RerankWorkerData,
  progress_callback: ProgressCallback,
) {
  env.cacheDir = setup.cacheDir;
  env.allowLocalModels = false;
  const tokenizer = yield* nativePromise(() =>
    AutoTokenizer.from_pretrained(setup.modelId, { progress_callback }),
  );
  // WebGPU only: on the CPU a read's batch takes seconds, past the time a search can wait.
  const model = yield* nativePromise(() =>
    AutoModelForSequenceClassification.from_pretrained(setup.modelId, {
      dtype: "fp32",
      model_file_name: setup.modelFileName,
      device: "webgpu",
      session_options: { enableCpuMemArena: false },
      progress_callback,
    }),
  );
  const loaded = { tokenizer, model };
  // The first run also compiles the device's kernels; a load that cannot run is no load.
  return yield* score(loaded, "준비", ["준비"], setup).pipe(
    Effect.as(loaded),
    Effect.tapError(() =>
      nativePromise(() => model.dispose()).pipe(ignoreLogged("rerank_model_dispose_failed")),
    ),
  );
});
interface LoadedModel {
  readonly tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  readonly model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
}

const handlers = RerankRpcs.toLayer(
  Effect.gen(function* () {
    const setup = yield* Schema.decodeUnknownEffect(RerankWorkerData)(workerData).pipe(
      Effect.mapError(failure("load")),
    );
    // Loaded once per worker. The worker's scope disposes of the model when the host closes the
    // worker, so the onnxruntime session is released before the thread exits.
    const scope = yield* Scope.Scope;
    // transformers.js reports a load's progress synchronously; each report goes on to the `Load`
    // stream as it is.
    const reports = yield* PubSub.unbounded<ProgressInfo>();
    const progress: ProgressCallback = (report) => PubSub.publishUnsafe(reports, report);
    const model = yield* Effect.cached(
      load(setup, progress).pipe(
        Effect.tap(({ model: loaded }) =>
          Scope.addFinalizer(
            scope,
            nativePromise(() => loaded.dispose()).pipe(ignoreLogged("rerank_model_dispose_failed")),
          ),
        ),
        Effect.mapError(failure("load")),
      ),
    );
    return RerankRpcs.of({
      Load: () =>
        downloadProgress(Stream.fromPubSub(reports)).pipe(
          Stream.map((each) => RerankLoadEvent.cases.downloading.make(each)),
          // Ends when the model has loaded.
          Stream.merge(Stream.fromEffect(Effect.as(model, RerankLoadEvent.cases.loaded.make({}))), {
            haltStrategy: "right",
          }),
        ),
      Score: ({ query, texts }) =>
        Effect.flatMap(model, (loaded) =>
          score(loaded, query, texts, setup).pipe(Effect.mapError(failure("run"))),
        ),
    });
  }),
);

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
// One request at a time: the session runs synchronously, and the host bounds requests the same way.
const server = RpcServer.layer(RerankRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(protocol),
);

// The worker's failed spans go to the owner thread, which puts them in defect notices and
// reports under the run that caused them.
await runNativeEffect(Layer.launch(Layer.provide(server, workerFailedSpansLayer)));
