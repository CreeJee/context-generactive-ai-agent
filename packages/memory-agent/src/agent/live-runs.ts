import { HashMap, Option, Deferred, Effect, Ref, Stream } from "effect";

/** A run whose model stream is still being produced in this process. */
export interface LiveRun {
  readonly runId: string;
  readonly controller: AbortController;
  readonly cancel: Effect.Effect<void>;
  /** Resolves once the stream has ended: finished, paused for approval, failed or cancelled. */
  readonly ended: Effect.Effect<void>;
}

/** One registry per AgentChat service. Only active streams occupy a session key. */
export const createLiveRuns = Effect.gen(function* () {
  const bySession = yield* Ref.make(HashMap.empty<string, LiveRun>());

  return {
    get: (sessionId: string): Effect.Effect<LiveRun | null> =>
      Effect.map(Ref.get(bySession), (runs) => Option.getOrNull(HashMap.get(runs, sessionId))),

    /** Claims a session until the returned stream finishes. */
    claim: Effect.fnUntraced(function* (options: {
      readonly sessionId: string;
      readonly runId: string;
      readonly controller: AbortController;
      readonly releaseResources?: Effect.Effect<void>;
      readonly cancelExecution?: Effect.Effect<void>;
      readonly settle?: Effect.Effect<void>;
    }): Effect.fn.Return<{
      readonly track: <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
      readonly release: Effect.Effect<void>;
    } | null> {
      const { sessionId, controller } = options;
      const done = yield* Deferred.make<void>();
      const run: LiveRun = {
        runId: options.runId,
        controller,
        cancel: options.cancelExecution ?? Effect.sync(() => controller.abort()),
        ended: Deferred.await(done),
      };
      const claimed = yield* Ref.modify(bySession, (runs) =>
        HashMap.has(runs, sessionId) ? [false, runs] : [true, HashMap.set(runs, sessionId, run)],
      );
      if (!claimed) return null;
      const released = yield* Ref.make(false);
      const release = (options.releaseResources ?? Effect.void).pipe(
        Effect.ensuring(
          Ref.update(bySession, (runs) =>
            Option.exists(HashMap.get(runs, sessionId), (held) => held === run)
              ? HashMap.remove(runs, sessionId)
              : runs,
          ),
        ),
        Effect.andThen(options.settle ?? Effect.void),
        Effect.ensuring(Deferred.succeed(done, undefined)),
        Effect.when(Effect.map(Ref.getAndSet(released, true), (was) => !was)),
        Effect.asVoid,
        Effect.uninterruptible,
      );
      return {
        release,
        track: <A, E, R>(stream: Stream.Stream<A, E, R>) => stream.pipe(Stream.ensuring(release)),
      };
    }),
  };
});

export type LiveRuns = Effect.Success<typeof createLiveRuns>;
