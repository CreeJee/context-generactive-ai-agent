import { Array as Arr, Context, Data, Effect, Layer, Option, type Path, Ref, Stream } from "effect";
import { logFailure } from "../../runtime/logged-failures.ts";
import type { EmbeddingChoice } from "../../config/contracts.ts";
import { GlobalConfig } from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import { AppEvents } from "../../events/app-events.ts";
import { type DownloadPurpose, type EmbeddingOverview, ModelDownload } from "./contracts.ts";
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
import { Reranker } from "../rerank/reranker.ts";
import { memoryPrompts } from "../prompts.ts";
import { WorkflowRules } from "../../workflow/rules.ts";
import { skillWorkflowRules } from "../../workflow/sources.ts";
import { Skills } from "../../skills/skills.ts";

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
  const reranker = yield* Reranker;
  const workflowRules = yield* WorkflowRules;
  const skills = yield* Skills;
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

  // The page shows a model's download as it goes.
  yield* Effect.forkIn(
    Stream.runForEach(downloads.changes, () => events.publishGlobal("downloads")),
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
  // downloading it) took seconds there. The workflow rules every project has are embedded next,
  // before the backfill, so a Goal's first turn does not wait for them. A changed chunk identity
  // must rebuild existing conversations even when no new import or chat arrives. The service Scope
  // owns the drain; failed nodes remain pending for the next run.
  const loadAndBackfill = Effect.forkIn(
    embedder.embed([memoryPrompts.warmUp], "query").pipe(
      Effect.catch(logFailure("memory_embedder_warm_up_failed")),
      // With the rules of the skills every project has; a project's own skills are embedded by its
      // first turn. A turn embeds what is still missing, as it did before.
      Effect.andThen(
        skills.shared.pipe(
          Effect.map(skillWorkflowRules),
          Effect.catchTag("PlatformError", (error) =>
            Effect.as(logFailure("workflow_skill_rules_unread")(error), []),
          ),
          Effect.flatMap(workflowRules.prepare),
          Effect.catch(logFailure("workflow_rule_vectors_failed")),
        ),
      ),
      Effect.andThen(indexer.indexAll()),
      Effect.catchTags({
        EmbeddingError: logFailure("memory_backfill_embedding_failed"),
        VectorIndexError: logFailure("memory_backfill_vector_failed"),
        IndexingError: (error) =>
          logFailure("memory_backfill_mapping_failed", { reason: error.reason })(error),
      }),
    ),
    layerScope,
  );
  yield* Effect.when(
    loadAndBackfill,
    Effect.succeed(EmbedderRuntime.$is("local")(embedder.runtime())),
  );

  /** What loads each model again: its next load downloads what is still missing. */
  const loadAgain = {
    embedding: Effect.asVoid(loadAndBackfill),
    rerank: reranker.retry,
    "gpu-check": startCheck,
  } satisfies Record<DownloadPurpose, Effect.Effect<void, never, Path.Path>>;

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
    /** The local models being downloaded, and the downloads that failed. */
    downloads: downloads.current,
    /** Downloads a model again after its download failed; nothing for any other model. */
    retryDownload: (purpose: DownloadPurpose) =>
      Effect.flatMap(downloads.current, (current) =>
        Effect.when(
          loadAgain[purpose],
          Effect.succeed(
            Arr.some(
              current,
              (download) => download.purpose === purpose && ModelDownload.guards.failed(download),
            ),
          ),
        ),
      ).pipe(Effect.andThen(downloads.current)),
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
