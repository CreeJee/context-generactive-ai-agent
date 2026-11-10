import { NodePath, NodeWorker } from "@effect/platform-node";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Worker } from "node:worker_threads";
import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Path,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { StorageRoot } from "../../config/storage-root.ts";
import { logFailure } from "../../runtime/logged-failures.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { type DownloadReport, ModelDownloads } from "../embedding/downloads.ts";
import { Embedder, EmbedderRuntime } from "../embedding/embedder.ts";
import {
  RerankLoadEvent,
  RerankRpcs,
  type RerankWorkerData,
  RerankWorkerFailed,
} from "./rerank-rpc.ts";

/**
 * The reranker the app runs: nlpai-lab/KURE-Reranker-nano, a Korean and English cross-encoder,
 * exported to ONNX because the original publishes only safetensors. Its fp16 file on WebGPU with
 * 192 tokens per pair took the search set's nDCG@10 from 0.400 to 0.581 at p50 ~1 s
 * (docs/decisions.md, 2026-11-06).
 */
export const rerankModel = {
  id: "CreeJee/KURE-Reranker-nano-ONNX",
  file: "model_fp16",
  maxTokens: 192,
} as const;

/**
 * How long a search waits for the scores: the time a search's native read gets. A batch past it
 * runs to its end in the worker, and the search keeps its own order.
 */
const rerankBudget = Duration.seconds(2);

export interface RerankerApi {
  /**
   * One relevance score per text for the query, in order, higher is more relevant. None when the
   * reranker cannot answer in time: still loading, not running on this machine, failed, or past
   * its budget.
   */
  readonly score: (
    query: string,
    texts: readonly string[],
  ) => Effect.Effect<Option.Option<readonly number[]>>;
  /** Loads the model again, in the background, when it is off after a failed load. */
  readonly retry: Effect.Effect<void>;
}

/** The running worker as the host uses it. */
interface RerankSession {
  readonly score: (
    query: string,
    texts: readonly string[],
  ) => Effect.Effect<readonly number[], RerankWorkerFailed>;
  /** Keeps the process alive while `work` runs; an idle worker must not. */
  readonly busy: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * The worker thread behind the reranker, with its model loaded; the load's download goes to
 * `report`. Transport failures mean it is gone.
 */
const rpcSession = (data: RerankWorkerData, report: DownloadReport) =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<Worker>();
    const lost = (cause: unknown) =>
      RerankWorkerFailed.make({ stage: "lost", reason: String(cause) });
    const file = yield* runtimeWorker("rerank-worker").pipe(Effect.mapError(lost));
    const options = yield* runtimeWorkerOptions(data);
    const workers = NodeWorker.layer(() => {
      const worker = new Worker(file, options);
      worker.unref();
      Deferred.doneUnsafe(spawned, Exit.succeed(worker));
      return worker;
    });
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(Layer.provide(workers)),
    );
    const client = yield* RpcClient.make(RerankRpcs).pipe(Effect.provide(protocol));
    const call = <A>(
      effect: Effect.Effect<A, RerankWorkerFailed | RpcClientError.RpcClientError>,
    ) => effect.pipe(Effect.catchTag("RpcClientError", (error) => Effect.fail(lost(error))));
    yield* call(
      client
        .Load()
        .pipe(
          Stream.runForEach(
            RerankLoadEvent.match({ downloading: report.progress, loaded: () => Effect.void }),
          ),
        ),
    ).pipe(Effect.onExit(report.ended));
    const worker = yield* Deferred.await(spawned);
    return {
      score: (query, texts) => call(client.Score({ query, texts })),
      busy: (work) =>
        Effect.acquireUseRelease(
          Effect.sync(() => worker.ref()),
          () => work,
          () => Effect.sync(() => worker.unref()),
        ),
    } satisfies RerankSession;
  }).pipe(
    Effect.catchTag("WorkerError", (error) =>
      Effect.fail(RerankWorkerFailed.make({ stage: "lost", reason: String(error) })),
    ),
  );

/** Where the reranker is: loading in the background, ready, or not available until a restart. */
type RerankState = Data.TaggedEnum<{
  loading: {};
  ready: { readonly session: RerankSession };
  unavailable: {};
}>;
const RerankState = Data.taggedEnum<RerankState>();

/**
 * The reranker in a worker thread on WebGPU, loaded in the background when the layer is built: the
 * first start downloads the model, and a search never waits for that. A worker that fails to load
 * or is lost leaves the reranker off until the app restarts or a retry loads it again.
 */
const makeLocal = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const paths = yield* Path.Path;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<RerankState>(RerankState.loading());
  const unavailable = (error: RerankWorkerFailed) =>
    Effect.andThen(
      logFailure("reranker_unavailable", { stage: error.stage })(error),
      Ref.set(state, RerankState.unavailable()),
    );
  const data: RerankWorkerData = {
    cacheDir: paths.join(storage.path, "models"),
    modelId: rerankModel.id,
    modelFileName: rerankModel.file,
    maxTokens: rerankModel.maxTokens,
  };
  const report = yield* ModelDownloads.report("rerank", rerankModel.id);
  // Each load's worker lives in a scope of its own, closed when the load fails.
  const load = Effect.flatMap(Scope.fork(scope), (attempt) =>
    rpcSession(data, report).pipe(
      Scope.provide(attempt),
      Effect.flatMap((session) => Ref.set(state, RerankState.ready({ session }))),
      Effect.catch((error) => Effect.andThen(Scope.close(attempt, Exit.void), unavailable(error))),
    ),
  );
  yield* Effect.forkIn(load, scope);
  // ONNX inference cannot be interrupted in place: a batch runs to its end, holding the worker.
  const oneRequest = yield* Semaphore.make(1);
  const run = (session: RerankSession, query: string, texts: readonly string[]) =>
    Effect.forkIn(
      oneRequest.withPermits(1)(Effect.uninterruptible(session.busy(session.score(query, texts)))),
      scope,
    ).pipe(
      Effect.flatMap((fiber) =>
        Fiber.join(fiber).pipe(
          Effect.timeoutOption(rerankBudget),
          // Past the budget, a request still waiting for the worker is dropped; a running batch
          // ends on its own.
          Effect.tap((scores) =>
            Effect.when(
              Effect.forkIn(Fiber.interrupt(fiber), scope),
              Effect.succeed(Option.isNone(scores)),
            ),
          ),
        ),
      ),
      Effect.catch((error) =>
        error.stage === "run"
          ? Effect.as(logFailure("rerank_failed")(error), Option.none())
          : Effect.as(unavailable(error), Option.none()),
      ),
    );
  return {
    score: (query, texts) =>
      Effect.flatMap(
        Ref.get(state),
        RerankState.$match({
          loading: () => Effect.succeedNone,
          unavailable: () => Effect.succeedNone,
          ready: ({ session }) =>
            texts.length === 0 ? Effect.succeedSome([]) : run(session, query, texts),
        }),
      ),
    retry: Ref.modify(state, (current) =>
      RerankState.$is("unavailable")(current) ? [true, RerankState.loading()] : [false, current],
    ).pipe(
      Effect.flatMap((again) => Effect.when(Effect.forkIn(load, scope), Effect.succeed(again))),
      Effect.asVoid,
    ),
  } satisfies RerankerApi;
});

/** Orders a search's candidates by a cross-encoder's relevance to the question. */
export class Reranker extends Context.Service<Reranker, RerankerApi>()(
  "memory-agent/memory/rerank/reranker",
) {
  /** No reranker: searches keep their fused order. */
  static readonly none = Layer.succeed(Reranker, {
    score: () => Effect.succeedNone,
    retry: Effect.void,
  });
  /** The local reranker on WebGPU, whatever the embedder; evaluations use it over a copy. */
  static readonly localGpu = Layer.effect(Reranker, makeLocal).pipe(Layer.provide(NodePath.layer));
  /**
   * The local reranker where the local embedder runs in gpu mode. A user who chose the CPU for the
   * embedder keeps the GPU unused, and test and evaluation embedders get no reranker.
   */
  static readonly local = Layer.unwrap(
    Effect.gen(function* () {
      const runtime = (yield* Embedder).runtime();
      return EmbedderRuntime.$is("local")(runtime) && runtime.mode === "gpu"
        ? Reranker.localGpu
        : Reranker.none;
    }),
  );
}
