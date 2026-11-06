import { NodePath, NodeWorker } from "@effect/platform-node";
import { Array as EffectArray, Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Worker } from "node:worker_threads";
import {
  Path,
  DateTime,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Schema,
  Scope,
  ScopedRef,
  Semaphore,
} from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { GpuCheck } from "../../config/contracts.ts";
import { GlobalConfig, type Settings } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { totalMemory } from "../../runtime/host-system.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { type ChunkSpan, chunkPolicy } from "./chunks.ts";
import { type EmbeddingDevice, EmbeddingMode, type EmbeddingOverview } from "./contracts.ts";
import { EmbeddingRpcs, type EmbeddingWorkerData, EmbeddingWorkerFailed } from "./embedding-rpc.ts";
import { type EmbeddingRole, localModel, modelFile } from "./models.ts";

export class EmbeddingError extends Schema.TaggedError<
  EmbeddingError,
  { readonly brand: unique symbol }
>()("EmbeddingError", {
  cause: Schema.Defect(),
}) {}

/** How an embedder runs, for settings (`contracts.ts`). Test and evaluation embedders are `other`. */
export type EmbedderRuntime = EmbeddingOverview["running"];
export const EmbedderRuntime = Data.taggedEnum<EmbedderRuntime>();

export interface EmbedderApi {
  /** Changes whenever vectors from this embedder are not comparable with earlier ones. */
  readonly identity: string;
  readonly dimensions: number;
  /** L2-normalized vectors, one per text, in order, each embedded with the role's prompt. */
  readonly embed: (
    texts: readonly string[],
    role: EmbeddingRole,
  ) => Effect.Effect<Float32Array[], EmbeddingError>;
  /** Local document windows; custom evaluation embedders may keep one vector per node. */
  readonly chunks?: (
    texts: readonly string[],
  ) => Effect.Effect<readonly (readonly ChunkSpan[])[], EmbeddingError>;
  readonly runtime: () => EmbedderRuntime;
}

export function normalize(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
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
  return order.reduce<number[][]>((batches, index) => {
    const current = batches.at(-1) ?? [];
    // Counts ascend, so the text joining a batch is its longest.
    const longest = tokenCounts[index]!;
    const fits =
      current.length > 0 &&
      current.length + 1 <= limits.size &&
      (current.length + 1) * longest * longest <= limits.cost;
    return fits ? [...batches.slice(0, -1), [...current, index]] : [...batches, [index]];
  }, []);
}

/** Which mode's file to load, and the devices to try it on in order. */
interface ModelSetup {
  readonly mode: EmbeddingMode;
  readonly devices: readonly EmbeddingDevice[];
}

const modes = {
  cpu: { mode: "cpu", devices: ["cpu"] },
  gpu: { mode: "gpu", devices: ["webgpu", "cpu"] },
} satisfies Record<EmbeddingMode, ModelSetup>;

/** Changes whenever the vectors of the model's file for `mode` are not comparable with earlier ones. */
export const embedderIdentity = (mode: EmbeddingMode) =>
  `${localModel.id}@${localModel.files[mode].tag}/${localModel.output}/${localModel.maxTokens}/chunks-v${chunkPolicy.version}-${chunkPolicy.tokens}-${chunkPolicy.overlap}`;

/** The mode whose file made vectors of `identity`, when the local model made them. */
export const identityMode = (identity: string) =>
  EffectArray.findFirst(EmbeddingMode.literals, (mode) => embedderIdentity(mode) === identity);

/**
 * From this much memory `auto` runs the model on the GPU (where WebGPU was found to work). Set
 * 2026-09 for granite on Apple Silicon: the full-precision model on WebGPU peaked at 2.9 GB against
 * 1.3 GB for the quantized one on the CPU, and used 0.7–0.8 cores against 3.4–3.7. EmbeddingGemma 2
 * peaks lower on WebGPU than on the CPU (2026-11, a batch of four 512-token texts: fp16 1.5 GB, q8
 * 1.8 GB), so the threshold now only keeps WebGPU off smaller machines.
 */
export const gpuMemoryThreshold = 16 * 1024 ** 3;

/** The gpu mode's model file, as a WebGPU check names it. */
export const gpuModelFile = `${localModel.id}/${modelFile("gpu")}`;

/** The stored WebGPU check, when it checked the file the gpu mode runs now. */
export const currentGpuCheck = (settings: Settings) =>
  Option.filter(Option.fromNullishOr(settings.gpuCheck), (check) => check.model === gpuModelFile);

/** The mode the app runs with, given the settings it starts with. */
export const embeddingModeFor: {
  (settings: Settings, memoryBytes: number): EmbeddingMode;
  (memoryBytes: number): (settings: Settings) => EmbeddingMode;
} = EffectFunction.dual((args) => !Schema.is(Schema.Finite)(args[0]), embeddingModeForBody);
function embeddingModeForBody(settings: Settings, memoryBytes: number): EmbeddingMode {
  return Match.value(settings.embeddingDevice ?? "auto").pipe(
    Match.withReturnType<EmbeddingMode>(),
    Match.when("cpu", () => "cpu"),
    Match.when("gpu", () => "gpu"),
    Match.when("auto", () =>
      memoryBytes >= gpuMemoryThreshold &&
      Option.exists(currentGpuCheck(settings), GpuCheck.guards.available)
        ? "gpu"
        : "cpu",
    ),
    Match.exhaustive,
  );
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
  /** Keeps the process alive while `work` runs; an idle worker must not. */
  readonly busy: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The worker thread behind a session. Transport failures mean the worker is gone. */
const rpcSession = (data: EmbeddingWorkerData) =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<Worker>();
    const lost = (cause: unknown) =>
      EmbeddingWorkerFailed.make({ stage: "lost", reason: String(cause) });
    const file = yield* runtimeWorker("embed-worker").pipe(Effect.mapError(lost));
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
    const client = yield* RpcClient.make(EmbeddingRpcs).pipe(Effect.provide(protocol));
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
 * the allocator (granite quint8: ~40 MB back) and each reload grows the footprint a little.
 *
 * The session lives in a `ScopedRef` owned by the caller's Scope: replacing it (after a lost
 * worker or a failed load) and closing the Scope both stop the worker and await its exit.
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
    modelFileName: localModel.files[setup.mode].file,
    output: localModel.output,
    textOnly: localModel.textOnly,
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
  const keepsSession = {
    run: true,
    load: false,
    lost: false,
  } as const satisfies Record<EmbeddingWorkerFailed["stage"], boolean>;
  const request = <A>(call: (current: ModelSession) => Effect.Effect<A, EmbeddingWorkerFailed>) =>
    Effect.flatMap(live, (current) =>
      // ONNX inference cannot be interrupted in place, and terminating the thread during a
      // session call aborts the whole process: onnxruntime-node cannot throw into a stopping
      // worker. An interrupted request holds the permit until its call ends, one batch at most,
      // and leaves the worker and its loaded model to the next request.
      Effect.uninterruptible(current.busy(call(current))).pipe(
        Effect.tapError((error) => (keepsSession[error.stage] ? Effect.void : discard)),
      ),
    ).pipe(
      Effect.mapError((cause) => EmbeddingError.make({ cause })),
      oneRequest.withPermits(1),
    );

  return {
    device: (): EmbeddingDevice | null =>
      Option.getOrNull(Option.map(ScopedRef.getUnsafe(session), (current) => current.device)),
    chunks: (texts: readonly string[]) => request((current) => current.chunk(texts)),
    embed: Effect.fnUntraced(function* (texts: readonly string[], role: EmbeddingRole) {
      if (texts.length === 0) return [];
      const prompted = texts.map((text) => localModel.prompts[role] + text);
      const counts = yield* request((current) => current.countTokens(prompted));
      // One worker serves one request at a time: batches run one after another.
      const embedded = yield* Effect.forEach(planBatches(counts), (batch) =>
        request((current) => current.embed(batch.map((index) => prompted[index]!))).pipe(
          Effect.map((rows) =>
            batch.map((index, position) => {
              const start = position * localModel.dimensions;
              return [index, normalize(rows.slice(start, start + localModel.dimensions))] as const;
            }),
          ),
        ),
      );
      return embedded
        .flat()
        .toSorted(([left], [right]) => left - right)
        .map(([, vector]) => vector);
    }),
  };
});

/** What a local embedder is for: the app (run as settings say) or evaluating a model file. */
type LocalPurpose = Data.TaggedEnum<{
  app: { readonly mode: EmbeddingMode };
  evaluation: {};
}>;
const LocalPurpose = Data.taggedEnum<LocalPurpose>();

const makeLocal = (setup: ModelSetup, purpose: LocalPurpose) =>
  Effect.gen(function* () {
    const storage = yield* StorageRoot;
    const paths = yield* Path.Path;
    const model = yield* modelWorker(paths.join(storage.path, "models"), setup);
    return {
      identity: embedderIdentity(setup.mode),
      dimensions: localModel.dimensions,
      runtime: () =>
        LocalPurpose.$match(purpose, {
          app: ({ mode }) => EmbedderRuntime.local({ mode, device: model.device() }),
          evaluation: () => EmbedderRuntime.other(),
        }),
      embed: model.embed,
      chunks: model.chunks,
    } satisfies EmbedderApi;
  });

/**
 * Whether the `gpu` mode's model file loads and runs on WebGPU here, in a worker of its own that
 * ends afterwards. Downloads that model file first when it is not cached yet.
 */
export const checkGpu = (storageRoot: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* Path.Path;

      const model = yield* modelWorker(paths.join(storageRoot, "models"), {
        mode: "gpu",
        devices: ["webgpu"],
      });
      /** Why the GPU cannot be used, if it cannot. */
      const unavailable = yield* model.embed(["준비"], "query").pipe(
        Effect.map(() =>
          model.device() === "webgpu" ? Option.none<string>() : Option.some("no WebGPU device"),
        ),
        Effect.catchTag("EmbeddingError", (error) =>
          Effect.succeedSome(
            // A code, not the worker's text: that can hold paths and native messages.
            Schema.is(EmbeddingWorkerFailed)(error.cause)
              ? `worker_${error.cause.stage}_failed`
              : "embedding_failed",
          ),
        ),
      );
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return Option.match(unavailable, {
        onNone: (): GpuCheck => GpuCheck.cases.available.make({ checkedAt, model: gpuModelFile }),
        onSome: (reason): GpuCheck =>
          GpuCheck.cases.unavailable.make({ checkedAt, reason, model: gpuModelFile }),
      });
    }),
  );

export class Embedder extends Context.Service<Embedder, EmbedderApi>()(
  "memory-agent/memory/embedding/embedder",
) {
  /** The local model (`models.ts`), cached under `<storage>/models`, run the way the settings say. */
  static readonly local = Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const mode = embeddingModeFor(yield* (yield* GlobalConfig).read, yield* totalMemory);
      return yield* makeLocal(modes[mode], LocalPurpose.app({ mode }));
    }),
  ).pipe(Layer.provide(NodePath.layer));
  /** The file a mode runs, on the CPU, to compare files' quality and memory. */
  static readonly localFile = (mode: EmbeddingMode) =>
    Layer.effect(Embedder, makeLocal({ mode, devices: ["cpu"] }, LocalPurpose.evaluation())).pipe(
      Layer.provide(NodePath.layer),
    );
}
