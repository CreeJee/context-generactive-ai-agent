import { NodePath, NodeWorker } from "@effect/platform-node";
import { Array as EffectArray, Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Worker } from "node:worker_threads";
import {
  Path,
  DateTime,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
  ScopedRef,
  Semaphore,
} from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { GlobalConfig, type GpuCheck, type Settings } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { totalMemory } from "../../runtime/host-system.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { type ChunkSpan, chunkPolicy } from "./chunks.ts";
import {
  type EmbeddingDevice,
  EmbeddingRpcs,
  type EmbeddingWorkerData,
  EmbeddingWorkerFailed,
} from "./embedding-rpc.ts";

export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly cause: unknown;
}> {}

export { EmbeddingDevice } from "./embedding-rpc.ts";

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
  /** Local document windows; custom evaluation embedders may keep one vector per node. */
  readonly chunks?: (
    texts: readonly string[],
  ) => Effect.Effect<readonly (readonly ChunkSpan[])[], EmbeddingError>;
  readonly runtime: () => EmbedderRuntime;
}

/** Chosen 2026-09: Apache-2.0, 384 dims, 32k context, Korean in its enhanced-support set. */
export const localModel = {
  id: "ibm-granite/granite-embedding-97m-multilingual-r2",
  dimensions: 384,
  /**
   * Query/direct-call limit. Indexed documents are first split into chunkPolicy windows, so
   * their tail is never discarded. Keep this separate from the document chunk size.
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
type BatchLimits = { readonly size: number; readonly cost: number };
export const planBatches: {
  (tokenCounts: readonly number[]): number[][];
  (tokenCounts: readonly number[], limits: BatchLimits): number[][];
  (limits: BatchLimits): (tokenCounts: readonly number[]) => number[][];
} = EffectFunction.dual((args) => EffectArray.isArray(args[0]), planBatchesBody);
function planBatchesBody(
  tokenCounts: readonly number[],
  limits: BatchLimits = {
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
export const embeddingModeFor: {
  (settings: Settings, memoryBytes: number): EmbeddingMode;
  (memoryBytes: number): (settings: Settings) => EmbeddingMode;
} = EffectFunction.dual((args) => !Schema.is(Schema.Finite)(args[0]), embeddingModeForBody);
function embeddingModeForBody(settings: Settings, memoryBytes: number): EmbeddingMode {
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
 * One running model worker as the host uses it. Production sessions speak Effect RPC to
 * `embed-worker.ts`; lifecycle tests supply a controlled one.
 */
export interface ModelSession {
  readonly device: EmbeddingDevice;
  readonly countTokens: (
    texts: readonly string[],
  ) => Effect.Effect<readonly number[], EmbeddingWorkerFailed>;
  readonly embed: (texts: readonly string[]) => Effect.Effect<Float32Array, EmbeddingWorkerFailed>;
  readonly chunk: (
    texts: readonly string[],
  ) => Effect.Effect<readonly (readonly ChunkSpan[])[], EmbeddingWorkerFailed>;
  /** Stops in-flight native work now: ONNX inference cannot be interrupted in place. */
  readonly terminate: Effect.Effect<void>;
  /** Keeps the process alive while `work` runs; an idle worker must not. */
  readonly busy: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The worker thread behind a session. Transport failures mean the worker is gone. */
const rpcSession = (data: EmbeddingWorkerData) =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<Worker>();
    const workers = NodeWorker.layer(() => {
      const worker = new Worker(runtimeWorker("embed-worker"), runtimeWorkerOptions(data));
      worker.unref();
      Deferred.doneUnsafe(spawned, Exit.succeed(worker));
      return worker;
    });
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(Layer.provide(workers)),
    );
    const client = yield* RpcClient.make(EmbeddingRpcs).pipe(Effect.provide(protocol));
    const lost = (cause: unknown) =>
      EmbeddingWorkerFailed.make({ stage: "lost", reason: String(cause) });
    const call = <A>(
      effect: Effect.Effect<A, EmbeddingWorkerFailed | RpcClientError.RpcClientError>,
    ) => effect.pipe(Effect.catchTag("RpcClientError", (error) => Effect.fail(lost(error))));
    const device = yield* call(client.Load());
    const worker = yield* Deferred.await(spawned);
    return {
      device,
      countTokens: (texts) => call(client.CountTokens({ texts })),
      embed: (texts) => call(client.Embed({ texts })),
      chunk: (texts) => call(client.Chunk({ texts })),
      terminate: Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
      busy: (work) =>
        Effect.acquireUseRelease(
          Effect.sync(() => worker.ref()),
          () => work,
          () => Effect.sync(() => worker.unref()),
        ),
    } satisfies ModelSession;
  }).pipe(
    Effect.catchTag("WorkerError", (error) =>
      Effect.fail(EmbeddingWorkerFailed.make({ stage: "lost", reason: String(error) })),
    ),
  );

/**
 * The model in a worker thread, started on the first request and kept. onnxruntime-node runs a
 * session synchronously, so on the main thread a backlog of batches held up every request the
 * server answered meanwhile: a start with ~1,100 nodes to embed kept settings waiting for over a
 * minute. Releasing the model when idle was measured and dropped: the freed memory mostly stays with
 * the allocator (quint8: ~40 MB back) and each reload grows the footprint a little.
 *
 * The session lives in a `ScopedRef` owned by the caller's Scope: replacing it (after a lost
 * worker or an interrupted request) and closing the Scope both stop the worker and await its exit.
 */
export const modelWorker = Effect.fnUntraced(function* (
  cacheDir: string,
  setup: ModelSetup,
  connect: (
    data: EmbeddingWorkerData,
  ) => Effect.Effect<ModelSession, EmbeddingWorkerFailed, Scope.Scope> = rpcSession,
) {
  const data: EmbeddingWorkerData = {
    cacheDir,
    modelId: localModel.id,
    modelFileName: variantFile[setup.variant],
    maxTokens: localModel.maxTokens,
    devices: setup.devices,
  };
  const session = yield* ScopedRef.make(() => Option.none<ModelSession>());
  // Bound physical worker work, not an entire document embedding. Queries can acquire a
  // permit between backfill batches; a cancelled waiter never starts a worker request.
  const oneRequest = yield* Semaphore.make(1);
  const discard = ScopedRef.set(session, Effect.succeed(Option.none<ModelSession>()));
  const live = Effect.flatMap(
    ScopedRef.get(session),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        // `set` acquires uninterruptibly; a model load must still stop when the Scope closes.
        ScopedRef.set(
          session,
          Effect.interruptible(connect(data)).pipe(Effect.map(Option.some)),
        ).pipe(
          Effect.andThen(ScopedRef.get(session)),
          // `set` just stored the session it acquired.
          Effect.map(Option.getOrThrow),
        ),
    }),
  );
  /** A worker that failed to load or was lost is replaced by the next request's new one. */
  const keepsSession = (error: EmbeddingWorkerFailed) => {
    switch (error.stage) {
      case "run":
        return true;
      case "load":
      case "lost":
        return false;
    }
  };
  const request = <A>(call: (current: ModelSession) => Effect.Effect<A, EmbeddingWorkerFailed>) =>
    Effect.flatMap(live, (current) =>
      current.busy(call(current)).pipe(
        // Only one request owns this worker: terminate it and await its exit before handing
        // the permit to another agent.
        Effect.onInterrupt(() => current.terminate.pipe(Effect.andThen(discard))),
        Effect.tapError((error) => (keepsSession(error) ? Effect.void : discard)),
      ),
    ).pipe(
      Effect.mapError((cause) => new EmbeddingError({ cause })),
      oneRequest.withPermits(1),
    );

  return {
    device: (): EmbeddingDevice | null =>
      Option.getOrNull(Option.map(ScopedRef.getUnsafe(session), (current) => current.device)),
    chunks: (texts: readonly string[]) => request((current) => current.chunk(texts)),
    embed: Effect.fnUntraced(function* (texts: readonly string[]) {
      if (texts.length === 0) return [];
      const counts = yield* request((current) => current.countTokens(texts));
      // One worker serves one request at a time: batches run one after another.
      const embedded = yield* Effect.forEach(planBatches(counts), (batch) =>
        request((current) => current.embed(batch.map((index) => texts[index]!))).pipe(
          Effect.map((rows) =>
            batch.map((index, position) => {
              const start = position * localModel.dimensions;
              return [index, normalize(rows.slice(start, start + localModel.dimensions))] as const;
            }),
          ),
        ),
      );
      const vectors: Float32Array[] = [];
      for (const [index, vector] of embedded.flat()) vectors[index] = vector;
      return vectors;
    }),
  };
});

/** What a local embedder is for: the app (run as settings say) or evaluating a model file. */
type LocalPurpose =
  | { readonly kind: "app"; readonly mode: EmbeddingMode }
  | { readonly kind: "evaluation" };

const makeLocal = (setup: ModelSetup, purpose: LocalPurpose) =>
  Effect.gen(function* () {
    const storage = yield* StorageRoot;
    const paths = yield* Path.Path;
    const model = yield* modelWorker(paths.join(storage.path, "models"), setup);
    return {
      identity: `${localModel.id}@${setup.variant}/cls/${localModel.maxTokens}/chunks-v${chunkPolicy.version}-${chunkPolicy.tokens}-${chunkPolicy.overlap}`,
      dimensions: localModel.dimensions,
      runtime: (): EmbedderRuntime => {
        switch (purpose.kind) {
          case "app":
            return { kind: "local", mode: purpose.mode, device: model.device() };
          case "evaluation":
            return { kind: "other" };
        }
      },
      embed: model.embed,
      chunks: model.chunks,
    } satisfies EmbedderApi;
  });

/**
 * Whether the full-precision model loads and runs on WebGPU here, in a worker of its own that ends
 * afterwards. Downloads that model file first when it is not cached yet.
 */
export const checkGpu = (storageRoot: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const effectClock = yield* Clock.Clock;
      const paths = yield* Path.Path;

      const model = yield* modelWorker(paths.join(storageRoot, "models"), {
        variant: "fp32",
        devices: ["webgpu"],
      });
      return yield* model.embed(["준비"]).pipe(
        Effect.map((): GpuCheck =>
          model.device() === "webgpu"
            ? {
                status: "available",
                checkedAt: DateTime.formatIso(
                  DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
                ),
              }
            : {
                status: "unavailable",
                checkedAt: DateTime.formatIso(
                  DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
                ),
                reason: "no WebGPU device",
              },
        ),
        Effect.catchTag("EmbeddingError", (error) =>
          Effect.succeed<GpuCheck>({
            status: "unavailable",
            checkedAt: DateTime.formatIso(
              DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
            ),
            reason: (error.cause instanceof Error
              ? error.cause.message
              : String(error.cause)
            ).slice(0, 300),
          }),
        ),
      );
    }),
  );

export class Embedder extends Context.Service<Embedder, EmbedderApi>()(
  "memory-agent/memory/embedding/embedder",
) {
  /** The local granite model, cached under `<storage>/models`, run the way the settings say. */
  static readonly local = Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const mode = embeddingModeFor(yield* (yield* GlobalConfig).read, yield* totalMemory);
      return yield* makeLocal(modes[mode], { kind: "app", mode });
    }),
  ).pipe(Layer.provide(NodePath.layer));
  /** Another published file on the CPU, to compare quality and memory. */
  static readonly localVariant = (variant: ModelVariant) =>
    Layer.effect(Embedder, makeLocal({ variant, devices: ["cpu"] }, { kind: "evaluation" })).pipe(
      Layer.provide(NodePath.layer),
    );
}
