import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** What the Kiwi worker is started with; the host owns every field. */
export const KiwiWorkerData = Schema.Struct({ modelDirectory: Schema.String });
export type KiwiWorkerData = typeof KiwiWorkerData.Type;

export class KiwiWorkerFailed extends Schema.TaggedError<KiwiWorkerFailed>()("KiwiWorkerFailed", {
  /**
   * `run`: one request failed and the worker stays. `load`: the model never loaded, and `lost`: the
   * worker or its transport is gone; the next request starts a new worker for both.
   */
  stage: Schema.Literals(["load", "run", "lost"]),
  reason: Schema.String,
}) {}

/** Builds the model once per worker. */
export const Load = Rpc.make("Load", { error: KiwiWorkerFailed });
/** Search terms per text, in order. */
export const Terms = Rpc.make("Terms", {
  payload: Schema.Struct({ texts: Schema.Array(Schema.String) }),
  success: Schema.Array(Schema.Array(Schema.String)),
  error: KiwiWorkerFailed,
});

export const KiwiRpcs = RpcGroup.make(Load, Terms);
