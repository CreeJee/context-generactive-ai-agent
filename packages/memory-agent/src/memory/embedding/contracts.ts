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
 * How the local model runs; chosen when the app starts.
 * - `cpu`: the quantized file on the CPU. The least memory; it takes several cores while it works.
 * - `gpu`: the full-precision file on WebGPU. A fraction of the CPU for about 1–1.6 GB more memory,
 *   and full-precision vectors. Where WebGPU is missing the same file runs on the CPU: the vectors
 *   are the same (measured cosine 1.0), only slower.
 */
export const EmbeddingMode = Schema.Literals(["cpu", "gpu"]);
export type EmbeddingMode = typeof EmbeddingMode.Type;

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
  memoryBytes: Schema.Finite,
  gpuMemoryThreshold: Schema.Finite,
  gpu: GpuState,
  /** Nodes the running embedder has not embedded yet. */
  unindexed: Schema.Finite,
  maintenance: MaintenanceOverview,
});
export type EmbeddingOverview = typeof EmbeddingOverview.Type;
