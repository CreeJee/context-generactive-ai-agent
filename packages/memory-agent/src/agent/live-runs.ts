import type { StreamChunk } from "@tanstack/ai";
import { Deferred, Effect } from "effect";

/** A run whose model stream is still being produced in this process. */
export interface LiveRun {
  readonly runId: string;
  readonly controller: AbortController;
  /** Resolves once the stream has ended: finished, paused for approval, failed or cancelled. */
  readonly ended: Effect.Effect<void>;
}

/** One registry per AgentChat service. Only active streams occupy a session key. */
export const createLiveRuns = Effect.sync(() => {
  const bySession = new Map<string, LiveRun>();

  return {
    get: (sessionId: string): LiveRun | null => bySession.get(sessionId) ?? null,

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
          if (bySession.has(sessionId)) return null;
          const run: LiveRun = { runId, controller, ended: Deferred.await(done) };
          bySession.set(sessionId, run);
          const release = () => {
            if (bySession.get(sessionId) === run) bySession.delete(sessionId);
            try {
              onEnded();
            } finally {
              Effect.runSync(Deferred.succeed(done, undefined));
            }
          };
          return {
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
