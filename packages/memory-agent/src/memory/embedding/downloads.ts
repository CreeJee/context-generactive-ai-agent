import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import type { DownloadProgress, DownloadPurpose, ModelDownload } from "./contracts.ts";
import { ModelDownload as Download } from "./contracts.ts";

/** Where one model's worker reports its download, and how the model's load ended. */
export interface DownloadReport {
  readonly progress: (progress: DownloadProgress) => Effect.Effect<void>;
  /**
   * The load ended. A load that failed before its download's end leaves the download as failed;
   * otherwise the download is gone.
   */
  readonly ended: <A, E>(exit: Exit.Exit<A, E>) => Effect.Effect<void>;
}

/** A report that goes nowhere: for tests and evaluations, which track no downloads. */
export const untrackedDownload: DownloadReport = {
  progress: () => Effect.void,
  ended: () => Effect.void,
};

/** When and at how many bytes a download's speed is measured from. */
interface Start {
  readonly at: number;
  readonly loaded: number;
}

interface Tracked {
  readonly download: ModelDownload;
  readonly start: Option.Option<Start>;
}

/** A guess at the time left needs this long a download to average over. */
const guessAfterMs = 5_000;

/** The time left at the download's average speed since `start`; none before that means much. */
const secondsLeft = (start: Start, now: number, { loaded, total }: DownloadProgress) => {
  const elapsed = now - start.at;
  const moved = loaded - start.loaded;
  return elapsed < guessAfterMs || moved <= 0 || loaded >= total
    ? null
    : Math.ceil(((total - loaded) / moved) * (elapsed / 1000));
};

/** A download stops when its load fails with bytes still to come or none known yet. */
const unfinished = (download: ModelDownload) =>
  Download.match(download, {
    downloading: ({ loaded, total }) => total === 0 || loaded < total,
    failed: () => true,
  });

const make = Effect.gen(function* () {
  const current = yield* SubscriptionRef.make(HashMap.empty<DownloadPurpose, Tracked>());
  return {
    /** The report of one model's download, by what the model is for. */
    track: (purpose: DownloadPurpose, model: string): DownloadReport => ({
      progress: (progress) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          SubscriptionRef.update(current, (downloads) => {
            const before = Option.flatMap(HashMap.get(downloads, purpose), ({ download, start }) =>
              Download.guards.downloading(download) ? start : Option.none(),
            );
            // Sizes not known yet give no speed to measure.
            const start = Option.orElse(before, () =>
              progress.total > 0
                ? Option.some({ at: now, loaded: progress.loaded })
                : Option.none(),
            );
            return HashMap.set(downloads, purpose, {
              download: Download.cases.downloading.make({
                purpose,
                model,
                ...progress,
                secondsLeft: Option.getOrNull(
                  Option.map(start, (from) => secondsLeft(from, now, progress)),
                ),
              }),
              start,
            });
          }),
        ),
      ended: (exit) =>
        SubscriptionRef.update(current, (downloads) =>
          Exit.isFailure(exit) &&
          !Cause.hasInterruptsOnly(exit.cause) &&
          Option.exists(HashMap.get(downloads, purpose), ({ download }) => unfinished(download))
            ? HashMap.set(downloads, purpose, {
                download: Download.cases.failed.make({ purpose, model }),
                start: Option.none(),
              })
            : HashMap.remove(downloads, purpose),
        ),
    }),
    /** The models being downloaded now, and the downloads that failed. */
    current: Effect.map(SubscriptionRef.get(current), (downloads) =>
      Array.from(HashMap.values(downloads), ({ download }) => download),
    ),
    /** Emits whenever a download moves on, starts, fails or ends. */
    changes: Stream.drop(SubscriptionRef.changes(current), 1),
  };
});

/** The local models being downloaded, as their workers report them, for the page. */
export class ModelDownloads extends Context.Service<ModelDownloads, Effect.Success<typeof make>>()(
  "memory-agent/memory/embedding/downloads/ModelDownloads",
) {
  static readonly layer = Layer.effect(ModelDownloads, make);
  /** The report of one model's download when the app tracks downloads; otherwise none. */
  static readonly report = (purpose: DownloadPurpose, model: string) =>
    Effect.map(
      Effect.serviceOption(ModelDownloads),
      Option.match({
        onNone: () => untrackedDownload,
        onSome: (downloads) => downloads.track(purpose, model),
      }),
    );
}
