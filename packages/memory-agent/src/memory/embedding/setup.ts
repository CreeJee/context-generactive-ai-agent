import { totalmem } from "node:os";
import { Context, Effect, Layer } from "effect";
import {
  GlobalConfig,
  type EmbeddingChoice,
  type GpuCheck,
  type Settings,
} from "../../config/global-config.ts";
import { StorageRoot } from "../../config/storage-root.ts";
import {
  checkGpu,
  Embedder,
  embeddingModeFor,
  gpuMemoryThreshold,
  type EmbedderRuntime,
  type EmbeddingMode,
} from "./embedder.ts";
import { Indexer } from "./indexer.ts";

/** Whether WebGPU was found to work here, or is being checked now. */
export type GpuState =
  | GpuCheck
  | { readonly status: "unchecked" }
  | { readonly status: "checking" };

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
}

/**
 * `auto` needs to know whether WebGPU works before it can pick the GPU, and so does a user who asks
 * for the GPU. A machine below the memory threshold stays on the CPU under `auto`, so it is not
 * checked unless asked.
 */
const wantsCheck = (settings: Settings, memoryBytes: number) => {
  if (settings.gpuCheck) return false;
  switch (settings.embeddingDevice ?? "auto") {
    case "cpu":
      return false;
    case "gpu":
      return true;
    case "auto":
      return memoryBytes >= gpuMemoryThreshold;
  }
};

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const storage = yield* StorageRoot;
  const embedder = yield* Embedder;
  const indexer = yield* Indexer;
  const memoryBytes = totalmem();
  const layerScope = yield* Effect.scope;
  let checking = false;

  /**
   * Checks WebGPU in the background and remembers the answer. It loads the full-precision model in
   * a worker of its own (downloading it first if needed), so it is done once, not on every start.
   */
  const startCheck = Effect.suspend(() => {
    // Tests and evaluations run other embedders; there is no local model to check for them.
    if (checking || embedder.runtime().kind !== "local") return Effect.void;
    checking = true;
    return Effect.asVoid(
      Effect.forkIn(
        checkGpu(storage.path).pipe(
          Effect.flatMap((result) => config.update({ gpuCheck: result })),
          Effect.catchAllCause(() => Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              checking = false;
            }),
          ),
        ),
        layerScope,
      ),
    );
  });

  if (wantsCheck(yield* config.read, memoryBytes)) yield* startCheck;

  const overview = Effect.gen(function* () {
    const settings = yield* config.read;
    const gpu: GpuState = checking
      ? { status: "checking" }
      : (settings.gpuCheck ?? { status: "unchecked" });
    return {
      choice: settings.embeddingDevice ?? "auto",
      running: embedder.runtime(),
      next: embeddingModeFor(settings, memoryBytes),
      memoryBytes,
      gpuMemoryThreshold,
      gpu,
      unindexed: yield* indexer.pending,
    } satisfies EmbeddingOverview;
  });

  return {
    overview,
    /** Saves how the model should run; it takes effect when the app next starts. */
    choose: (choice: EmbeddingChoice) =>
      Effect.gen(function* () {
        const settings = yield* config.update({ embeddingDevice: choice });
        if (wantsCheck(settings, memoryBytes)) yield* startCheck;
        return yield* overview;
      }),
    /** Checks WebGPU again, for a machine whose drivers or hardware changed. */
    recheck: Effect.zipRight(startCheck, overview),
  };
});

/** How the embedding model runs: the setting, what it resolves to, and whether WebGPU works. */
export class EmbeddingSetup extends Context.Tag("memory-agent/EmbeddingSetup")<
  EmbeddingSetup,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.scoped(EmbeddingSetup, make);
}
