import { Context, Deferred, Effect, Layer, Queue, Stream } from "effect";

/**
 * How long a piece waits for its turn before it writes anyway, when the server does not answer.
 * SQLite's lock still keeps the two connections apart then; only the order is lost.
 */
const unansweredAfter = "30 seconds";

/** A piece waiting for its turn: granted by the server, done once the piece is written. */
interface Turn {
  readonly granted: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<void>;
}

const make = Effect.gen(function* () {
  const waiting = yield* Queue.unbounded<Turn>();
  const asked = yield* Queue.unbounded<void>();
  return {
    /** One event per piece that asks for a turn, for the server to answer with `grant`. */
    asked: Stream.fromQueue(asked),
    /** Lets the oldest waiting piece write, and returns once it is written. */
    grant: Queue.take(waiting).pipe(
      Effect.tap((turn) => Deferred.succeed(turn.granted, undefined)),
      Effect.flatMap((turn) => Deferred.await(turn.done)),
    ),
    /** Runs `effect` in its turn. */
    writing: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const turn: Turn = {
            granted: yield* Deferred.make<void>(),
            done: yield* Deferred.make<void>(),
          };
          yield* Queue.offer(waiting, turn);
          yield* Queue.offer(asked, undefined);
          return turn;
        }),
        (turn) =>
          Deferred.await(turn.granted).pipe(
            Effect.timeoutOption(unansweredAfter),
            Effect.andThen(effect),
          ),
        (turn) => Deferred.succeed(turn.done, undefined),
      ),
  };
});

/**
 * Turns on the server's connection for the pass's pieces. The pass writes through a connection of
 * its own, and SQLite lets one connection write at a time: one that finds the lock taken can only
 * ask again later, in no order, and a long transcript written piece after piece kept the server's
 * writes waiting. So each piece first asks the server, which holds its own connection for the
 * piece (`sql.reserve`) in line with its own statements, and neither waits on the lock.
 */
export class WriteTurns extends Context.Service<WriteTurns, Effect.Success<typeof make>>()(
  "memory-agent/imports/write-turns/WriteTurns",
) {
  static readonly layer = Layer.effect(WriteTurns, make);
}
