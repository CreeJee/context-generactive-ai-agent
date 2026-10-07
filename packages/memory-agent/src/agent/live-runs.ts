import type { StreamChunk } from "@tanstack/ai";
import { MutableHashMap, Option, Deferred, Effect, Stream } from "effect";

/** A run whose model stream is still being produced in this process. */
export interface LiveRun {
  readonly runId: string;
  readonly controller: AbortController;
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
    ): Effect.Effect<{
      readonly track: (stream: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
    } | null> =>
      Effect.flatMap(Deferred.make<void>(), (done) =>
        Effect.sync(() => {
          if (MutableHashMap.has(bySession, sessionId)) return null;
          const run: LiveRun = { runId, controller, ended: Deferred.await(done) };
          MutableHashMap.set(bySession, sessionId, run);
          const release = () => {
            if (Option.getOrUndefined(MutableHashMap.get(bySession, sessionId)) === run)
              MutableHashMap.remove(bySession, sessionId);
            try {
              onEnded();
            } finally {
              Effect.runSync(Deferred.succeed(done, undefined));
            }
          };
          return {
            track: (stream) =>
              Stream.toAsyncIterable(
                Stream.fromAsyncIterable(stream, (error) => error).pipe(
                  Stream.ensuring(Effect.sync(release)),
                ),
              ),
          };
        }),
      ),
  };
});

export type LiveRuns = Effect.Success<typeof createLiveRuns>;
