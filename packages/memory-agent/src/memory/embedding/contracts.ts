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

/** A local model being downloaded: the embedding model or the reranker, by its Hugging Face id. */
export const ModelDownload = Schema.Struct({
  purpose: Schema.Literals(["embedding", "rerank"]),
  model: Schema.String,
  ...DownloadProgress.fields,
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
  /** Local models being downloaded now; empty once their files are cached. */
  downloads: Schema.Array(ModelDownload),
  maintenance: MaintenanceOverview,
});
export type EmbeddingOverview = typeof EmbeddingOverview.Type;
