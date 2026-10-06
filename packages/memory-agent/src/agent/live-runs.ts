import type { StreamChunk } from "@tanstack/ai";
import { MutableHashMap, Option, Deferred, Effect } from "effect";

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
            // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
            // @effect-diagnostics-next-line asyncFunction:off
            track: async function* (stream) {
              try {
                yield* stream;
              } finally {
                release();
              }
            },
          };
        }),
      ),
  };
});

export type LiveRuns = Effect.Success<typeof createLiveRuns>;
