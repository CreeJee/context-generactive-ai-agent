import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DownloadProgress } from "../embedding/contracts.ts";

/** What the rerank worker is started with; the host owns every field. */
export const RerankWorkerData = Schema.Struct({
  cacheDir: Schema.String,
  modelId: Schema.String,
  modelFileName: Schema.String,
  /** Tokens of one query and text pair; the longer side is cut first. */
  maxTokens: Schema.Finite,
});
export type RerankWorkerData = typeof RerankWorkerData.Type;

export class RerankWorkerFailed extends Schema.TaggedError<
  RerankWorkerFailed,
  { readonly brand: unique symbol }
>()("RerankWorkerFailed", {
  /**
   * `run`: one request failed and the worker stays. `load`: the model never loaded on the GPU, and
   * `lost`: the worker or its transport is gone.
   */
  stage: Schema.Literals(["load", "run", "lost"]),
  reason: Schema.String,
}) {}

/** What loading the model reports: the files' download as it goes, then that it loaded. */
export const RerankLoadEvent = Schema.TaggedUnion({
  downloading: DownloadProgress.fields,
  loaded: {},
});
export type RerankLoadEvent = typeof RerankLoadEvent.Type;

/** Loads the model on WebGPU once per worker and runs it on a short pair. */
export const Load = Rpc.make("Load", {
  success: RerankLoadEvent,
  error: RerankWorkerFailed,
  stream: true,
});
/** One relevance logit per text for the query, in order; higher is more relevant. */
export const Score = Rpc.make("Score", {
  payload: Schema.Struct({ query: Schema.String, texts: Schema.Array(Schema.String) }),
  success: Schema.Array(Schema.Finite),
  error: RerankWorkerFailed,
});

export const RerankRpcs = RpcGroup.make(Load, Score);
