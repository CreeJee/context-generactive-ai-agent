import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Transferable } from "effect/workers";
import { ChunkSpan } from "./chunks.ts";

/** Where the model runs. */
export const EmbeddingDevice = Schema.Literals(["cpu", "webgpu"]);
export type EmbeddingDevice = typeof EmbeddingDevice.Type;

/** What the embedding worker is started with; the host owns every field. */
export const EmbeddingWorkerData = Schema.Struct({
  cacheDir: Schema.String,
  modelId: Schema.String,
  modelFileName: Schema.String,
  maxTokens: Schema.Finite,
  /** In order of preference: the first that loads and runs a short text is used. */
  devices: Schema.Array(EmbeddingDevice),
});
export type EmbeddingWorkerData = typeof EmbeddingWorkerData.Type;

export class EmbeddingWorkerFailed extends Schema.TaggedError<
  EmbeddingWorkerFailed,
  { readonly brand: unique symbol }
>()("EmbeddingWorkerFailed", {
  /**
   * `run`: one request failed and the worker stays. `load`: the model never loaded, and `lost`:
   * the worker or its transport is gone; the next request starts a new worker for both.
   */
  stage: Schema.Literals(["load", "run", "lost"]),
  reason: Schema.String,
}) {}

const Texts = Schema.Struct({ texts: Schema.Array(Schema.String) });

/** Loads the model once per worker and reports the device it runs on. */
export const Load = Rpc.make("Load", { success: EmbeddingDevice, error: EmbeddingWorkerFailed });
export const CountTokens = Rpc.make("CountTokens", {
  payload: Texts,
  success: Schema.Array(Schema.Finite),
  error: EmbeddingWorkerFailed,
});
/** The batch's CLS rows, not yet normalized; the buffer is transferred, not copied. */
export const Embed = Rpc.make("Embed", {
  payload: Texts,
  success: Transferable.schema(Schema.instanceOf(Float32Array), (rows) => [rows.buffer]),
  error: EmbeddingWorkerFailed,
});
export const Chunk = Rpc.make("Chunk", {
  payload: Texts,
  success: Schema.Array(Schema.Array(ChunkSpan)),
  error: EmbeddingWorkerFailed,
});

export const EmbeddingRpcs = RpcGroup.make(Load, CountTokens, Embed, Chunk);
