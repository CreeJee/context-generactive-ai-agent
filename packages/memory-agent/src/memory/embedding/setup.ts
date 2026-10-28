import { isTruthy } from "../../truthy.ts";
import { Context, Data, Effect, Layer, Match, Ref } from "effect";
import { logFailure } from "../../runtime/logged-failures.ts";
import { GlobalConfig, type EmbeddingChoice, type Settings } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { totalMemory } from "../../runtime/host-system.ts";
import { AppEvents } from "../../events/app-events.ts";
import {
  checkGpu,
  Embedder,
  embeddingModeFor,
  gpuMemoryThreshold,
  EmbedderRuntime,
  type EmbeddingMode,
} from "./embedder.ts";
import { MemoryGraphMaintenance } from "../maintenance.ts";
import { Indexer } from "./indexer.ts";

/**
 * Whether WebGPU was found to work here, or is being checked now. The first two cases are the
 * stored `GpuCheck`.
 */
export type GpuState = Data.TaggedEnum<{
  available: { readonly checkedAt: string };
  unavailable: { readonly checkedAt: string; readonly reason: string };
  unchecked: {};
  checking: {};
}>;
export const GpuState = Data.taggedEnum<GpuState>();

export interface EmbeddingOverview {
  readonly choice: EmbeddingChoice;
  /** How the model runs in this process. */
  readonly running: EmbedderRuntime;
  /** How it will run from the next start, with the settings as they are now. */
  readonly next: EmbeddingMode;
  readonly memoryBytes: number;
  readonly gpuMemoryThreshold: number;
  readonly gpu: GpuState;
  /** Nodes the running embedder has not embedded yet. */
  readonly unindexed: number;
  readonly maintenance: Effect.Success<MemoryGraphMaintenance["Service"]["overview"]>;
}

/**
 * `auto` needs to know whether WebGPU works before it can pick the GPU, and so does a user who asks
 * for the GPU. A machine below the memory threshold stays on the CPU under `auto`, so it is not
 * checked unless asked.
 */
const wantsCheck = (settings: Settings, memoryBytes: number) =>
  !isTruthy(settings.gpuCheck) &&
  Match.value(settings.embeddingDevice ?? "auto").pipe(
    Match.when("cpu", () => false),
    Match.when("gpu", () => true),
    Match.when("auto", () => memoryBytes >= gpuMemoryThreshold),
    Match.exhaustive,
  );

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const storage = yield* StorageRoot;
  const events = yield* AppEvents;
  const embedder = yield* Embedder;
  const indexer = yield* Indexer;
  const maintenance = yield* MemoryGraphMaintenance;
  const memoryBytes = yield* totalMemory;
  const layerScope = yield* Effect.scope;
  const checking = yield* Ref.make(false);

  /**
   * Checks WebGPU in the background and remembers the answer. It loads the full-precision model in
   * a worker of its own (downloading it first if needed), so it is done once, not on every start.
   */
  const startCheck = Effect.gen(function* () {
    // Tests and evaluations run other embedders; there is no local model to check for them.
    if (!EmbedderRuntime.$is("local")(embedder.runtime())) return;
    if (yield* Ref.getAndSet(checking, true)) return;
    yield* events.publishGlobal("embedding");
    yield* Effect.forkIn(
      checkGpu(storage.path).pipe(
        Effect.flatMap((result) => config.update({ gpuCheck: result })),
        // Unchecked stays unchecked; the next start or a changed setting checks again.
        Effect.catch(logFailure("embedding_gpu_check_failed")),
        Effect.ensuring(
          Effect.andThen(Ref.set(checking, false), events.publishGlobal("embedding")),
        ),
      ),
      layerScope,
    );
  });

  yield* Effect.when(
    startCheck,
    Effect.map(config.read, (settings) => wantsCheck(settings, memoryBytes)),
  );

  // A changed chunk identity must rebuild existing conversations even when no new import or
  // chat arrives. The service Scope owns the drain; failed nodes remain pending for the next run.
  yield* Effect.when(
    Effect.forkIn(
      indexer.indexAll().pipe(
        Effect.catchTags({
          EmbeddingError: () => Effect.logWarning("memory_backfill_embedding_failed"),
          VectorIndexError: () => Effect.logWarning("memory_backfill_vector_failed"),
          IndexingError: () => Effect.logWarning("memory_backfill_mapping_failed"),
        }),
      ),
      layerScope,
    ),
    Effect.succeed(EmbedderRuntime.$is("local")(embedder.runtime())),
  );

  const overview = Effect.gen(function* () {
    const settings = yield* config.read;
    const gpu: GpuState = (yield* Ref.get(checking))
      ? GpuState.checking()
      : (settings.gpuCheck ?? GpuState.unchecked());
    return {
      choice: settings.embeddingDevice ?? "auto",
      running: embedder.runtime(),
      next: embeddingModeFor(settings, memoryBytes),
      memoryBytes,
      gpuMemoryThreshold,
      gpu,
      unindexed: yield* indexer.pending,
      maintenance: yield* maintenance.overview,
    } satisfies EmbeddingOverview;
  });

  return {
    overview,
    /** Saves how the model should run; it takes effect when the app next starts. */
    choose: (choice: EmbeddingChoice) =>
      Effect.gen(function* () {
        const settings = yield* config.update({ embeddingDevice: choice });
        yield* events.publishGlobal("embedding");
        yield* maintenance.start;
        yield* Effect.when(startCheck, Effect.succeed(wantsCheck(settings, memoryBytes)));
        return yield* overview;
      }),
    /** Checks WebGPU again, for a machine whose drivers or hardware changed. */
    recheck: Effect.andThen(startCheck, overview),
  };
});

/** How the embedding model runs: the setting, what it resolves to, and whether WebGPU works. */
export class EmbeddingSetup extends Context.Service<EmbeddingSetup, Effect.Success<typeof make>>()(
  "memory-agent/memory/embedding/setup/EmbeddingSetup",
) {
  static readonly layer = Layer.effect(EmbeddingSetup, make).pipe(
    Layer.provideMerge(MemoryGraphMaintenance.layer),
  );
}
