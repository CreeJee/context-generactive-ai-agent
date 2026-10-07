import type { StreamChunk } from "@tanstack/ai";
import { MutableHashMap, Option, Deferred, Effect, Stream } from "effect";

/** A run whose model stream is still being produced in this process. */
export interface LiveRun {
  readonly runId: string;
  readonly controller: AbortController;
  readonly cancel: Effect.Effect<void>;
  /** Resolves once the stream has ended: finished, paused for approval, failed or cancelled. */
  readonly ended: Effect.Effect<void>;
}

/** One registry per AgentChat service. Only active streams occupy a session key. */
export const createLiveRuns = Effect.sync(() => {
  const bySession = MutableHashMap.empty<string, LiveRun>();

  return {
    get: (sessionId: string): LiveRun | null =>
      Option.getOrUndefined(MutableHashMap.get(bySession, sessionId)) ?? null,

    /** Claims a session until the returned stream finishes. */
    claim: (
      sessionId: string,
      runId: string,
      controller: AbortController,
      onEnded: () => void = () => {},
      releaseResources: Effect.Effect<void> = Effect.void,
      cancelExecution: Effect.Effect<void> = Effect.sync(() => controller.abort()),
      settle: Effect.Effect<void> = Effect.void,
    ): Effect.Effect<{
      readonly track: <E, R>(
        stream: Stream.Stream<StreamChunk, E, R>,
      ) => Stream.Stream<StreamChunk, E, R>;
      readonly release: Effect.Effect<void>;
    } | null> =>
      Effect.flatMap(Deferred.make<void>(), (done) =>
        Effect.sync(() => {
          if (MutableHashMap.has(bySession, sessionId)) return null;
          const run: LiveRun = {
            runId,
            controller,
            cancel: cancelExecution,
            ended: Deferred.await(done),
          };
          MutableHashMap.set(bySession, sessionId, run);
          let released = false;
          const release = Effect.suspend(() => {
            if (released) return Effect.void;
            released = true;
            return releaseResources.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (Option.getOrUndefined(MutableHashMap.get(bySession, sessionId)) === run)
                    MutableHashMap.remove(bySession, sessionId);
                  onEnded();
                }),
              ),
              Effect.andThen(settle),
              Effect.ensuring(Deferred.succeed(done, undefined)),
            );
          }).pipe(Effect.uninterruptible);
          return {
            release,
            track: <E, R>(stream: Stream.Stream<StreamChunk, E, R>) =>
              stream.pipe(Stream.ensuring(release)),
          };
        }),
      ),
  };
});

export type LiveRuns = Effect.Success<typeof createLiveRuns>;
