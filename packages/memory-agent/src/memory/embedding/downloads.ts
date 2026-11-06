import { Context, Effect, HashMap, Layer, Option, Stream, SubscriptionRef } from "effect";
import type { DownloadProgress, ModelDownload } from "./contracts.ts";

/** Where one model's worker reports its download; it says `done` once the model has loaded. */
export interface DownloadReport {
  readonly progress: (progress: DownloadProgress) => Effect.Effect<void>;
  readonly done: Effect.Effect<void>;
}

/** A report that goes nowhere: for tests and evaluations, which track no downloads. */
export const untrackedDownload: DownloadReport = {
  progress: () => Effect.void,
  done: Effect.void,
};

const make = Effect.gen(function* () {
  const current = yield* SubscriptionRef.make(HashMap.empty<string, ModelDownload>());
  return {
    /** The report of one model's download, by what the model is for. */
    track: (purpose: ModelDownload["purpose"], model: string): DownloadReport => ({
      progress: (progress) =>
        SubscriptionRef.update(current, HashMap.set(model, { purpose, model, ...progress })),
      done: SubscriptionRef.update(current, HashMap.remove(model)),
    }),
    /** The models being downloaded now. */
    current: Effect.map(SubscriptionRef.get(current), (downloads) => [
      ...HashMap.values(downloads),
    ]),
    /** Emits whenever a download moves on, starts or ends. */
    changes: Stream.drop(SubscriptionRef.changes(current), 1),
  };
});

/** The local models being downloaded, as their workers report them, for the settings page. */
export class ModelDownloads extends Context.Service<ModelDownloads, Effect.Success<typeof make>>()(
  "memory-agent/memory/embedding/downloads/ModelDownloads",
) {
  static readonly layer = Layer.effect(ModelDownloads, make);
  /** The report of one model's download when the app tracks downloads; otherwise none. */
  static readonly report = (purpose: ModelDownload["purpose"], model: string) =>
    Effect.map(
      Effect.serviceOption(ModelDownloads),
      Option.match({
        onNone: () => untrackedDownload,
        onSome: (downloads) => downloads.track(purpose, model),
      }),
    );
}
