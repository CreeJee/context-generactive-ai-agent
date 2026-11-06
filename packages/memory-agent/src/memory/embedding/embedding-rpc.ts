import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Transferable } from "effect/workers";
import { ChunkSpan } from "./chunks.ts";
import { DownloadProgress, EmbeddingDevice } from "./contracts.ts";
import { EmbeddingOutput } from "./models.ts";

/** What the embedding worker is started with; the host owns every field. */
export const EmbeddingWorkerData = Schema.Struct({
  cacheDir: Schema.String,
  modelId: Schema.String,
  modelFileName: Schema.String,
  output: EmbeddingOutput,
  textOnly: Schema.Boolean,
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

/** What loading the model reports: the files' download as it goes, then the device it runs on. */
export const LoadEvent = Schema.TaggedUnion({
  downloading: DownloadProgress.fields,
  loaded: { device: EmbeddingDevice },
});
export type LoadEvent = typeof LoadEvent.Type;

/** Loads the model once per worker; ends with the device it runs on. */
export const Load = Rpc.make("Load", {
  success: LoadEvent,
  error: EmbeddingWorkerFailed,
  stream: true,
});
export const CountTokens = Rpc.make("CountTokens", {
  payload: Texts,
  success: Schema.Array(Schema.Finite),
  error: EmbeddingWorkerFailed,
});
/** The batch's sentence vectors, not yet normalized; the buffer is transferred, not copied. */
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
