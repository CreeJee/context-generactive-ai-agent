import { HashMap, HashSet, Option, Deferred, Effect, Ref, Stream } from "effect";

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
  // Runs and writes share one Ref so that checking one and taking the other cannot be split.
  const held = yield* Ref.make({
    runs: HashMap.empty<string, LiveRun>(),
    writers: HashSet.empty<string>(),
  });

  return {
    get: (sessionId: string): Effect.Effect<LiveRun | null> =>
      Effect.map(Ref.get(held), ({ runs }) => Option.getOrNull(HashMap.get(runs, sessionId))),

    /** The sessions whose run is producing now. */
    sessionIds: Effect.map(Ref.get(held), ({ runs }): readonly string[] => [...HashMap.keys(runs)]),

    /**
     * Runs `write` while nothing else may start on the session: a run saves the whole conversation
     * after each step, so a message appended beside one would be overwritten. Null when a run or
     * another write holds the session. The hold is not a run: `get` and `sessionIds` do not show it.
     */
    writing: <A, E, R>(
      sessionId: string,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A | null, E, R> =>
      Effect.acquireUseRelease(
        Ref.modify(held, (state) =>
          HashMap.has(state.runs, sessionId) || HashSet.has(state.writers, sessionId)
            ? [false, state]
            : [true, { ...state, writers: HashSet.add(state.writers, sessionId) }],
        ),
        (acquired) => (acquired ? write : Effect.succeed(null)),
        (acquired) =>
          Effect.when(
            Ref.update(held, (state) => ({
              ...state,
              writers: HashSet.remove(state.writers, sessionId),
            })),
            Effect.succeed(acquired),
          ),
      ),

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
      const claimed = yield* Ref.modify(held, (state) =>
        HashMap.has(state.runs, sessionId) || HashSet.has(state.writers, sessionId)
          ? [false, state]
          : [true, { ...state, runs: HashMap.set(state.runs, sessionId, run) }],
      );
      if (!claimed) return null;
      const released = yield* Ref.make(false);
      const release = (options.releaseResources ?? Effect.void).pipe(
        Effect.ensuring(
          Ref.update(held, (state) =>
            Option.exists(HashMap.get(state.runs, sessionId), (current) => current === run)
              ? { ...state, runs: HashMap.remove(state.runs, sessionId) }
              : state,
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
