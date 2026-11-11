import { NodePath, NodeWorker } from "@effect/platform-node";
import {
  Array as EffectArray,
  Function as EffectFunction,
  Iterable as EffectIterable,
} from "effect";
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
  Option,
  Schema,
  Scope,
  ScopedRef,
  Stream,
  TxRef,
} from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { type EmbeddingChoice, GpuCheck } from "../../config/contracts.ts";
import { GlobalConfig, type Settings } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { type ChunkSpan, chunkPolicy } from "./chunks.ts";
import {
  type DownloadPurpose,
  type EmbeddingDevice,
  EmbeddingMode,
  type EmbeddingOverview,
} from "./contracts.ts";
import { type DownloadReport, ModelDownloads } from "./downloads.ts";
import {
  EmbeddingRpcs,
  type EmbeddingWorkerData,
  EmbeddingWorkerFailed,
  LoadEvent,
} from "./embedding-rpc.ts";
import { type EmbeddingRole, localModel, modelFile } from "./models.ts";
import { memoryPrompts } from "../prompts.ts";

export class EmbeddingError extends Schema.TaggedError<
  EmbeddingError,
  { readonly brand: unique symbol }
>()("EmbeddingError", {
  cause: Schema.Defect(),
}) {}

/** How an embedder runs, for settings (`contracts.ts`). Test and evaluation embedders are `other`. */
export type EmbedderRuntime = EmbeddingOverview["running"];
export const EmbedderRuntime = Data.taggedEnum<EmbedderRuntime>();

/**
 * Whether someone waits on an embedding: `interactive` (a question, a turn's rules) goes to the
 * worker before any `background` work (the backfill) still waiting for it.
 */
export type EmbeddingPriority = "interactive" | "background";

/** A query is asked by someone waiting; documents are indexed in the background. */
export const defaultPriority = {
  query: "interactive",
  document: "background",
} as const satisfies Record<EmbeddingRole, EmbeddingPriority>;

export interface EmbedderApi {
  /** Changes whenever vectors from this embedder are not comparable with earlier ones. */
  readonly identity: string;
  readonly dimensions: number;
  /**
   * L2-normalized vectors, one per text, in order, each embedded with the role's prompt. The
   * priority is the role's {@link defaultPriority} unless the caller says otherwise.
   */
  readonly embed: (
    texts: readonly string[],
    role: EmbeddingRole,
    priority?: EmbeddingPriority,
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
  // Each text gets a batch number: it joins the batch before it when it fits, or starts the next.
  const [, numbered] = EffectArray.mapAccum(order, { batch: -1, size: 0 }, (current, index) => {
    // Counts ascend, so the text joining a batch is its longest.
    const longest = tokenCounts[index]!;
    const fits =
      current.size > 0 &&
      current.size + 1 <= limits.size &&
      (current.size + 1) * longest * longest <= limits.cost;
    const next = fits
      ? { batch: current.batch, size: current.size + 1 }
      : { batch: current.batch + 1, size: 1 };
    return [next, { index, batch: next.batch }] as const;
  });
  // Iterable's groupWith reads the texts once; Array's copies the rest of them for every batch.
  return EffectArray.fromIterable(
    EffectIterable.groupWith(numbered, (first, text) => text.batch === first.batch),
  ).map((batch) => batch.map((text) => text.index));
}

/** Which mode's file to load, and the devices to try it on in order. */
interface ModelSetup {
  readonly mode: EmbeddingMode;
  readonly devices: readonly EmbeddingDevice[];
  /** What the page calls the model's download. */
  readonly purpose: DownloadPurpose;
}

const modes = {
  cpu: { mode: "cpu", devices: ["cpu"], purpose: "embedding" },
  gpu: { mode: "gpu", devices: ["webgpu", "cpu"], purpose: "embedding" },
} satisfies Record<EmbeddingMode, ModelSetup>;

/** Changes whenever the vectors of the model's file for `mode` are not comparable with earlier ones. */
export const embedderIdentity = (mode: EmbeddingMode) =>
  `${localModel.id}@${localModel.files[mode].tag}/${localModel.output}/${localModel.maxTokens}/chunks-v${chunkPolicy.version}-${chunkPolicy.tokens}-${chunkPolicy.overlap}`;

/** The mode whose file made vectors of `identity`, when the local model made them. */
export const identityMode = (identity: string) =>
  EffectArray.findFirst(EmbeddingMode.literals, (mode) => embedderIdentity(mode) === identity);

/** The gpu mode's model file, as a WebGPU check names it. */
export const gpuModelFile = `${localModel.id}/${modelFile("gpu")}`;

/** The stored WebGPU check, when it checked the file the gpu mode runs now. */
export const currentGpuCheck = (settings: Settings) =>
  Option.filter(Option.fromNullishOr(settings.gpuCheck), (check) => check.model === gpuModelFile);

/**
 * The mode each choice runs. `auto` is the gpu mode, which falls back to its own file on the CPU
 * where WebGPU fails (`modes`), so no check is needed first and the vectors never depend on the
 * machine. EmbeddingGemma 2 on WebGPU is faster and takes less memory than on the CPU
 * (docs/decisions.md, 2026-11-06).
 */
const modeOfChoice = {
  auto: "gpu",
  cpu: "cpu",
  gpu: "gpu",
} as const satisfies Record<EmbeddingChoice, EmbeddingMode>;

/** The mode the app runs with, given the settings it starts with. */
export const embeddingModeFor = (settings: Settings): EmbeddingMode =>
  modeOfChoice[settings.embeddingDevice ?? "auto"];

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

/**
 * The worker thread behind a session, with its model loaded; the load's download goes to `report`.
 * Transport failures mean the worker is gone.
 */
const rpcSession = (report: DownloadReport) => (data: EmbeddingWorkerData) =>
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
    const { device } = yield* call(
      client
        .Load()
        .pipe(
          Stream.tap(LoadEvent.match({ downloading: report.progress, loaded: () => Effect.void })),
          Stream.filter(LoadEvent.guards.loaded),
          Stream.runHead,
        ),
    ).pipe(
      Effect.flatMap(Effect.fromOption(() => lost("the model's load ended without a device"))),
      Effect.onExit(report.ended),
    );
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
  connect?: (
    data: EmbeddingWorkerData,
  ) => Effect.Effect<ModelSession, EmbeddingWorkerFailed, Scope.Scope>,
) {
  // The worker's download shows on the page when the app tracks downloads.
  const open = connect ?? rpcSession(yield* ModelDownloads.report(setup.purpose, localModel.id));
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
  // One worker request at a time, not an entire document embedding: a question takes the worker
  // between backfill batches, ahead of any background request still waiting. A cancelled waiter
  // never starts a worker request.
  const busy = yield* TxRef.make(false);
  /** Interactive requests waiting for the worker or using it; background ones wait for none. */
  const interactive = yield* TxRef.make(0);
  const take = (priority: EmbeddingPriority) =>
    Effect.tx(
      Effect.gen(function* () {
        if (
          (yield* TxRef.get(busy)) ||
          (priority === "background" && (yield* TxRef.get(interactive)) > 0)
        )
          return yield* Effect.txRetry;
        yield* TxRef.set(busy, true);
      }),
    );
  const oneRequest =
    (priority: EmbeddingPriority) =>
    <A, E, R>(work: Effect.Effect<A, E, R>) => {
      const held = Effect.acquireUseRelease(
        Effect.interruptible(take(priority)),
        () => work,
        () => TxRef.set(busy, false),
      );
      return priority === "interactive"
        ? Effect.acquireUseRelease(
            TxRef.update(interactive, (count) => count + 1),
            () => held,
            () => TxRef.update(interactive, (count) => count - 1),
          )
        : held;
    };
  const discard = ScopedRef.set(session, Effect.succeed(Option.none<ModelSession>()));
  const live = Effect.flatMap(
    ScopedRef.get(session),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        // `set` acquires uninterruptibly; a model load must still stop when the Scope closes.
        ScopedRef.set(session, Effect.interruptible(open(data)).pipe(Effect.map(Option.some))).pipe(
          Effect.andThen(ScopedRef.get(session)),
          // `set` just stored the session it acquired.
          Effect.map(Option.getOrThrow),
          Effect.withSpan("Embedder.startWorker"),
        ),
    }),
  );
  /** A worker that failed to load or was lost is replaced by the next request's new one. */
  const keepsSession = {
    run: true,
    load: false,
    lost: false,
  } as const satisfies Record<EmbeddingWorkerFailed["stage"], boolean>;
  const request = <A>(
    priority: EmbeddingPriority,
    call: (current: ModelSession) => Effect.Effect<A, EmbeddingWorkerFailed>,
  ) =>
    Effect.flatMap(live, (current) =>
      // ONNX inference cannot be interrupted in place, and terminating the thread during a
      // session call aborts the whole process: onnxruntime-node cannot throw into a stopping
      // worker. An interrupted request holds the permit until its calls end, a count and one batch
      // at most, and leaves the worker and its loaded model to the next request.
      Effect.uninterruptible(current.busy(call(current))).pipe(
        Effect.tapError((error) => (keepsSession[error.stage] ? Effect.void : discard)),
      ),
    ).pipe(
      Effect.mapError((cause) => EmbeddingError.make({ cause })),
      oneRequest(priority),
    );

  return {
    device: (): EmbeddingDevice | null =>
      Option.getOrNull(Option.map(ScopedRef.getUnsafe(session), (current) => current.device)),
    // Only the indexer chunks documents, in the background.
    chunks: (texts: readonly string[]) => request("background", (current) => current.chunk(texts)),
    // Its span shows how long a caller waits for the worker between the worker's own calls.
    embed: Effect.fn("Embedder.embed")(function* (
      texts: readonly string[],
      role: EmbeddingRole,
      priority: EmbeddingPriority = defaultPriority[role],
    ) {
      if (texts.length === 0) return [];
      const prompted = texts.map((text) => localModel.prompts[role] + text);
      const embedBatch = (current: ModelSession, batch: readonly number[]) =>
        Effect.map(current.embed(batch.map((index) => prompted[index]!)), (rows) =>
          batch.map((index, position) => {
            const start = position * localModel.dimensions;
            return [index, normalize(rows.slice(start, start + localModel.dimensions))] as const;
          }),
        );
      // The count and the first batch take one turn of the worker. A question is one batch, and
      // with a turn each it waited behind a backfill batch twice.
      const first = yield* request(priority, (current) =>
        Effect.flatMap(current.countTokens(prompted), (counts) =>
          EffectArray.matchLeft(planBatches(counts), {
            onEmpty: () => Effect.succeed({ rows: [], rest: [] }),
            onNonEmpty: (batch, rest) =>
              Effect.map(embedBatch(current, batch), (rows) => ({ rows, rest })),
          }),
        ),
      );
      // One worker serves one request at a time: batches run one after another.
      const others = yield* Effect.forEach(first.rest, (batch) =>
        request(priority, (current) => embedBatch(current, batch)),
      );
      return [first.rows, ...others]
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
        purpose: "gpu-check",
      });
      /** Why the GPU cannot be used, if it cannot. */
      const unavailable = yield* model.embed([memoryPrompts.warmUp], "query").pipe(
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
      const mode = embeddingModeFor(yield* (yield* GlobalConfig).read);
      return yield* makeLocal(modes[mode], LocalPurpose.app({ mode }));
    }),
  ).pipe(Layer.provide(NodePath.layer));
  /** The file a mode runs, on the CPU, to compare files' quality and memory. */
  static readonly localFile = (mode: EmbeddingMode) =>
    Layer.effect(
      Embedder,
      makeLocal({ mode, devices: ["cpu"], purpose: "embedding" }, LocalPurpose.evaluation()),
    ).pipe(Layer.provide(NodePath.layer));
}
