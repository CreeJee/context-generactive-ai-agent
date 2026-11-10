import { Context, Data, Effect, Layer, Option, Ref, Stream } from "effect";
import { logFailure } from "../../runtime/logged-failures.ts";
import type { EmbeddingChoice } from "../../config/contracts.ts";
import { GlobalConfig } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { AppEvents } from "../../events/app-events.ts";
import type { EmbeddingOverview } from "./contracts.ts";
import {
  checkGpu,
  currentGpuCheck,
  Embedder,
  embeddingModeFor,
  EmbedderRuntime,
} from "./embedder.ts";
import { MemoryGraphMaintenance } from "../maintenance.ts";
import { ModelDownloads } from "./downloads.ts";
import { Indexer } from "./indexer.ts";
import { memoryPrompts } from "../prompts.ts";

/** Whether WebGPU was found to work here, or is being checked now (`contracts.ts`). */
export type GpuState = EmbeddingOverview["gpu"];
export const GpuState = Data.taggedEnum<GpuState>();

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const storage = yield* StorageRoot;
  const events = yield* AppEvents;
  const embedder = yield* Embedder;
  const indexer = yield* Indexer;
  const maintenance = yield* MemoryGraphMaintenance;
  const downloads = yield* ModelDownloads;
  const layerScope = yield* Effect.scope;
  const checking = yield* Ref.make(false);

  /**
   * Checks WebGPU in the background and remembers the answer, for the settings page; the mode does
   * not depend on it, as the gpu mode falls back to the CPU by itself. It loads the gpu mode's model
   * file in a worker of its own (downloading it first if needed), so it runs only when asked: at
   * start it would load the file beside the embedder's own worker.
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

  // The settings page shows a model's download as it goes.
  yield* Effect.forkIn(
    Stream.runForEach(downloads.changes, () => events.publishGlobal("embedding")),
    layerScope,
  );

  // Journaled node changes, a whole rebuild after a new lexical index among them, are applied
  // whatever the embedder; failed batches stay journaled for the next run.
  yield* Effect.forkIn(
    indexer.lexicalAll().pipe(
      Effect.catchTags({
        VectorIndexError: logFailure("memory_lexical_backfill_failed"),
        IndexingError: (error) =>
          logFailure("memory_lexical_backfill_failed", { reason: error.reason })(error),
      }),
    ),
    layerScope,
  );
  // The model loads here, not in the first message's search: loading it (and on a first start,
  // downloading it) took seconds there. A changed chunk identity must rebuild existing
  // conversations even when no new import or chat arrives. The service Scope owns the drain;
  // failed nodes remain pending for the next run.
  yield* Effect.when(
    Effect.forkIn(
      embedder.embed([memoryPrompts.warmUp], "query").pipe(
        Effect.catch(logFailure("memory_embedder_warm_up_failed")),
        Effect.andThen(indexer.indexAll()),
        Effect.catchTags({
          EmbeddingError: logFailure("memory_backfill_embedding_failed"),
          VectorIndexError: logFailure("memory_backfill_vector_failed"),
          IndexingError: (error) =>
            logFailure("memory_backfill_mapping_failed", { reason: error.reason })(error),
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
      : Option.getOrElse(currentGpuCheck(settings), () => GpuState.unchecked());
    return {
      choice: settings.embeddingDevice ?? "auto",
      running: embedder.runtime(),
      next: embeddingModeFor(settings),
      gpu,
      unindexed: yield* indexer.pending,
      downloads: yield* downloads.current,
      maintenance: yield* maintenance.overview,
    } satisfies EmbeddingOverview;
  });

  return {
    overview,
    /** Saves how the model should run; it takes effect when the app next starts. */
    choose: (choice: EmbeddingChoice) =>
      Effect.gen(function* () {
        yield* config.update({ embeddingDevice: choice });
        yield* events.publishGlobal("embedding");
        yield* maintenance.start;
        return yield* overview;
      }),
    /** Checks WebGPU, first or again for a machine whose drivers or hardware changed. */
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
