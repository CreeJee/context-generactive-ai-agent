import { Schema } from "effect";
import { EmbeddingChoice, GpuCheck } from "../../config/contracts.ts";

/**
 * How the embedding setup looks on the settings page. This module imports no server code, so the
 * browser bundle can use it; `setup.ts` builds the overview.
 */

/** Where the model runs. */
export const EmbeddingDevice = Schema.Literals(["cpu", "webgpu"]);
export type EmbeddingDevice = typeof EmbeddingDevice.Type;

/**
 * How the local model runs; chosen when the app starts. Each mode runs its own file of the model
 * (`models.ts`).
 * - `cpu`: the quantized file on the CPU. It takes several cores while it works.
 * - `gpu`: the GPU file on WebGPU. A fraction of the CPU; for EmbeddingGemma 2 also about five times
 *   as fast and 0.4 GB less memory. Where WebGPU is missing the same file runs on the CPU: the
 *   vectors are the same, only slower.
 */
export const EmbeddingMode = Schema.Literals(["cpu", "gpu"]);
export type EmbeddingMode = typeof EmbeddingMode.Type;

/** Bytes of a model's files being downloaded now, summed over those files. */
export const DownloadProgress = Schema.Struct({ loaded: Schema.Finite, total: Schema.Finite });
export type DownloadProgress = typeof DownloadProgress.Type;

/**
 * What a downloaded model is for: the embedding model the app runs, the reranker, or the gpu mode's
 * file that the settings page's WebGPU check loads. At most one download each.
 */
export const DownloadPurpose = Schema.Literals(["embedding", "rerank", "gpu-check"]);
export type DownloadPurpose = typeof DownloadPurpose.Type;

/**
 * A local model's download, by its Hugging Face id.
 * - `downloading`: bytes so far of the files it downloads. A `total` of 0 means their sizes are not
 *   known yet; `loaded` equal to `total` means the files are in and the model is loading.
 *   `secondsLeft` follows the download's average speed so far, once it has run for a few seconds.
 * - `failed`: the download stopped before its end; it stays until the model is loaded again.
 */
export const ModelDownload = Schema.TaggedUnion({
  downloading: {
    purpose: DownloadPurpose,
    model: Schema.String,
    ...DownloadProgress.fields,
    secondsLeft: Schema.NullOr(Schema.Finite),
  },
  failed: { purpose: DownloadPurpose, model: Schema.String },
});
export type ModelDownload = typeof ModelDownload.Type;

/** How an embedder runs, for settings. Test and evaluation embedders are `other`. */
const EmbedderRuntime = Schema.TaggedUnion({
  local: {
    mode: EmbeddingMode,
    /** Null until the model has loaded. */
    device: Schema.NullOr(EmbeddingDevice),
  },
  other: {},
});

/**
 * Whether WebGPU was found to work here, or is being checked now. The first two cases are the
 * stored `GpuCheck`.
 */
const GpuState = Schema.Union([GpuCheck, Schema.TaggedUnion({ unchecked: {}, checking: {} })]);

/** How far the automatic repairs of older links got (`maintenance.ts`). */
const MaintenanceOverview = Schema.Struct({
  version: Schema.Finite,
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  scanned: Schema.Finite,
  repairedEdges: Schema.Finite,
  suppressedEdges: Schema.Finite,
  retiredTopics: Schema.Finite,
  error: Schema.NullOr(Schema.String),
});

export const EmbeddingOverview = Schema.Struct({
  choice: EmbeddingChoice,
  /** How the model runs in this process. */
  running: EmbedderRuntime,
  /** How it will run from the next start, with the settings as they are now. */
  next: EmbeddingMode,
  gpu: GpuState,
  /** Nodes the running embedder has not embedded yet. */
  unindexed: Schema.Finite,
  maintenance: MaintenanceOverview,
});
export type EmbeddingOverview = typeof EmbeddingOverview.Type;
